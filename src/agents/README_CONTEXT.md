# Agent Context Management

Agent 层的上下文管理功能，包括上下文窗口、Token 估算和压缩触发。

## 目录职责

`src/agents/` 中与上下文相关的文件：

- **context.ts**：上下文窗口查找和 Token 预估缓存
- **context-window-guard.ts**：上下文窗口验证和溢出检测
- **session-transcript-repair.ts**：Session 记录修复（tool_use/tool_result 配对）
- **session-write-lock.ts**：Session 文件写入锁（并发控制）

---

## 核心设计

### 为什么需要 Agent 层的上下文管理？

1. **模型适配**：不同模型有不同的上下文窗口
2. **Token 预估**：在 API 调用前预估 token 使用
3. **安全性**：防止发送超出上下文窗口的请求
4. **并发控制**：避免多个进程同时写入同一 session 文件

---

## 文件详解

### `context.ts`

上下文窗口查找和 Token 预估缓存。

#### 核心函数

##### 1. lookupContextTokens

```typescript
export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // 启动缓存加载（不阻塞）
  void ensureContextWindowCacheLoaded();
  return MODEL_CACHE.get(modelId);
}
```

**用途：** 查找模型的上下文窗口大小。

**加载顺序：**
```
1. 配置文件覆盖（config.models.providers.<provider>.models[].contextWindow）
2. pi-coding-agent 内置模型
3. 配置的默认值（config.agents.defaults.contextTokens）
```

**为什么需要缓存？**
- 减少重复加载
- 支持 1M token 模型（Anthropic claude-opus-4/claude-sonnet-4）
- 冷启动优化

##### 2. applyDiscoveredContextWindows

```typescript
export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}): void {
  for (const model of params.models) {
    if (!model?.id) continue;
    const contextWindow =
      typeof model.contextWindow === "number"
        ? Math.trunc(model.contextWindow)
        : undefined;
    if (!contextWindow || contextWindow <= 0) continue;

    const existing = params.cache.get(model.id);
    // 多个提供商同一模型，选择较小的窗口（fail-safe）
    if (existing === undefined || contextWindow < existing) {
      params.cache.set(model.id, contextWindow);
    }
  }
}
```

**为什么选择较小的窗口？**
- Fail-safe：避免高估导致溢出
- 跨提供商一致性

##### 3. resolveContextTokensForModel

```typescript
export function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
}): number | undefined {
  // 1. 覆盖优先
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  // 2. 1M Token 模型检测
  const ref = resolveProviderModelRef({
    provider: params.provider,
    model: params.model,
  });
  if (ref) {
    const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
    if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;  // 1,048,576
    }
  }

  // 3. 从缓存查找
  return lookupContextTokens(params.model) ?? params.fallbackContextTokens;
}
```

**1M Token 模型：**
- `claude-opus-4*`
- `claude-sonnet-4*`

---

### `context-window-guard.ts`

上下文窗口验证和警告。

#### 核心函数

##### 1. resolveContextWindowInfo

```typescript
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  // 1. modelsConfig 优先
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers;
    const providerEntry = providers?.[params.provider];
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();

  // 2. Model 提供的窗口
  const fromModel = normalizePositiveInt(params.modelContextWindow);

  // 3. 基础信息
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" }
    : fromModel
      ? { tokens: fromModel, source: "model" }
      : { tokens: Math.floor(params.defaultTokens), source: "default" };

  // 4. 应用 agents.contextTokens cap
  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}
```

**优先级：**
```
1. config.agents.defaults.contextTokens（最高优先级）
2. config.models.providers.<provider>.models[].contextWindow
3. Model 提供的 contextWindow
4. 默认值
```

##### 2. evaluateContextWindowGuard

```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS));
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));

  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,  // 警告但允许
    shouldBlock: tokens > 0 && tokens < hardMin   // 阻止执行
  };
}
```

**阈值用途：**
- `shouldWarn`：通知用户上下文较小，可能影响性能
- `shouldBlock`：上下文过小，阻止执行

---

### `session-transcript-repair.ts`

Session 记录修复，确保 tool_use 和 tool_result 正确配对。

#### 核心问题

```
问题：Anthropic/Cloud Code Assist 要求 tool_use 必须紧接 tool_result
原因：Session 文件可能因为并发、崩溃等原因导致错位
影响：API 返回 400 错误，拒绝整个请求
```

#### 核心函数

##### 1. repairToolUseResultPairing

```typescript
export function repairToolUseResultPairing(
  messages: AgentMessage[]
): ToolUseRepairReport {
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 跳过非 assistant 消息
    if (msg.role !== "assistant") {
      // 丢弃孤立的 tool_result
      if (msg.role === "toolResult") {
        droppedOrphanCount++;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;

    // 跳过错误/中止的 assistant 消息
    const stopReason = assistant.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(msg);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    // 收集后续的 toolResult
    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j++) {
      const next = messages[j];
      const nextRole = next.role;

      if (nextRole === "assistant") break;  // 遇到下一个 assistant 消息，停止

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          // 丢弃重复的 toolResult
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount++;
            changed = true;
            continue;
          }
          const normalizedToolResult = normalizeToolResultName(toolResult, toolCallNamesById.get(id));
          spanResultsById.set(id, normalizedToolResult);
          continue;
        }
      }

      // 丢弃不匹配当前 assistant 的 toolResult
      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount++;
        changed = true;
      }
    }

    out.push(msg);

    // 将 tool_result 紧接 tool_use
    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        // 插入合成错误 tool_result
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
    }

    // 附加剩余消息
    for (const rem of remainder) {
      out.push(rem);
    }
    i = j - 1;
  }

  return {
    messages: changed || moved ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changed || moved,
  };
}
```

**修复策略：**
1. **移动**：将 tool_result 移动到对应的 tool_use 之后
2. **去重**：删除重复的 toolResult（基于 toolCallId）
3. **丢弃孤立项**：删除没有匹配 tool_use 的 toolResult
4. **合成**：为缺失的 tool_result 插入合成错误消息

##### 2. makeMissingToolResult

```typescript
function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  };
}
```

**为什么需要合成错误？**
- 明确标识此为修复后的错误
- API 不会因为缺失 tool_result 而拒绝
- 提供诊断信息

---

### `session-write-lock.ts`

Session 文件写入锁，防止并发冲突。

#### 核心设计

```
问题：多个进程/协程同时写入同一 session 文件
方案：文件锁 + PID 检测 + 看门狗
```

#### 核心类型

```typescript
type LockFilePayload = {
  pid?: number;              // 持有锁的进程 ID
  createdAt?: string;         // 锁创建时间
  starttime?: number;         // 进程启动时间（防止 PID 复用）
};

type HeldLock = {
  count: number;             // 重入计数
  handle: fs.FileHandle;     // 文件句柄
  lockPath: string;          // 锁文件路径
  acquiredAt: number;        // 获取锁的时间
  maxHoldMs: number;         // 最大持有时间
  releasePromise?: Promise<void>;
};
```

#### 核心函数

##### 1. acquireSessionWriteLock

```typescript
export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  allowReentrant?: boolean;
}): Promise<{
  release: () => Promise<void>;
}> {
  registerCleanupHandlers();  // 注册进程退出清理
  const timeoutMs = resolvePositiveMs(params.timeoutMs, 10_000, { allowInfinity: true });
  const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);  // 30 分钟
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, DEFAULT_MAX_HOLD_MS);  // 5 分钟

  const sessionFile = path.resolve(params.sessionFile);
  const lockPath = `${sessionFile}.lock`;
  const allowReentrant = params.allowReentrant ?? true;

  // 重入检查
  const held = HELD_LOCKS.get(normalizedSessionFile);
  if (allowReentrant && held) {
    held.count += 1;
    return {
      release: async () => {
        await releaseHeldLock(normalizedSessionFile, held);
      },
    };
  }

  // 获取锁（带重试）
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt++;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx");  // 独占创建

      const createdAt = new Date().toISOString();
      const starttime = getProcessStartTime(process.pid);
      const lockPayload: LockFilePayload = {
        pid: process.pid,
        createdAt,
        ...(starttime !== null && { starttime })
      };
      await handle.writeFile(JSON.stringify(lockPayload, null, 2), "utf8");

      const createdHeld: HeldLock = {
        count: 1,
        handle,
        lockPath,
        acquiredAt: Date.now(),
        maxHoldMs,
      };
      HELD_LOCKS.set(normalizedSessionFile, createdHeld);
      return {
        release: async () => {
          await releaseHeldLock(normalizedSessionFile, createdHeld);
        },
      };
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {}
        try {
          await fs.rm(lockPath, { force: true });
        } catch {}
      }

      if (err.code !== "EEXIST") {
        throw err;
      }

      // 检查锁是否过期
      const payload = await readLockPayload(lockPath);
      const nowMs = Date.now();
      const inspected = inspectLockPayload(payload, staleMs, nowMs);

      // 检查孤儿自身锁（同一 PID 但不在 HELD_LOCKS 中）
      const orphanSelfLock = shouldTreatAsOrphanSelfLock({
        payload,
        normalizedSessionFile,
      });
      const reclaimDetails = orphanSelfLock
        ? {
            ...inspected,
            stale: true,
            staleReasons: [
              ...inspected.staleReasons,
              "orphan-self-pid"
            ]
          }
        : inspected;

      if (await shouldReclaimContendedLockFile(lockPath, reclaimDetails, staleMs, nowMs)) {
        await fs.rm(lockPath, { force: true });
        continue;  // 重试获取锁
      }

      const delay = Math.min(1000, 50 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const payload = await readLockPayload(lockPath);
  const owner = typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown";
  throw new Error(`session file locked (timeout ${timeoutMs}ms): ${owner} ${lockPath}`);
}
```

**锁获取流程：**
1. 重入检查（如果允许）
2. 尝试创建锁文件（`wx` 模式）
3. 成功：写入 PID 和启动时间
4. 失败：检查锁是否过期
5. 过期：删除并重试
6. 超时：抛出错误

##### 2. PID 复用检测

```typescript
function shouldTreatAsOrphanSelfLock(params: {
  payload: LockFilePayload | null;
  normalizedSessionFile: string;
}): boolean {
  const pid = isValidLockNumber(params.payload?.pid) ? params.payload.pid : null;
  if (pid !== process.pid) {
    return false;
  }

  // 有有效的 starttime，说明不是孤儿
  const hasValidStarttime = isValidLockNumber(params.payload?.starttime);
  if (hasValidStarttime) {
    return false;
  }

  // 同一 PID，无 starttime，不在 HELD_LOCKS 中 = 孤儿
  return !HELD_LOCKS.has(params.normalizedSessionFile);
}
```

**为什么需要？**
- PID 可能被 OS 复用
- 如果新进程获得相同的 PID，但旧锁还在
- 无 starttime 时，通过检查是否在 HELD_LOCKS 中判断

##### 3. 看门狗

```typescript
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;  // 1 分钟

function runLockWatchdogCheck(nowMs = Date.now()): Promise<number> {
  let released = 0;
  for (const [sessionFile, held] of HELD_LOCKS.entries()) {
    const heldForMs = nowMs - held.acquiredAt;
    if (heldForMs <= held.maxHoldMs) {
      continue;
    }

    console.warn(
      `[session-write-lock] releasing lock held for ${heldForMs}ms (max=${held.maxHoldMs}ms): ${held.lockPath}`
    );

    const didRelease = await releaseHeldLock(sessionFile, held, { force: true });
    if (didRelease) {
      released++;
    }
  }
  return released;
}
```

**看门狗作用：**
- 定期检查持有的锁
- 超过 `maxHoldMs` 强制释放
- 防止死锁或异常导致锁永久持有

##### 4. 清理处理器

```typescript
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;

function handleTerminationSignal(signal: CleanupSignal): void {
  releaseAllLocksSync();  // 同步释放所有锁
  // ... 重新发送信号
}

function registerCleanupHandlers(): void {
  // 进程退出时清理
  process.on("exit", () => {
    releaseAllLocksSync();
  });

  // 信号处理
  for (const signal of CLEANUP_SIGNALS) {
    process.on(signal, () => handleTerminationSignal(signal));
  }

  // 启动看门狗
  ensureWatchdogStarted(DEFAULT_WATCHDOG_INTERVAL_MS);
}
```

---

## 使用示例

### 查询上下文窗口

```typescript
import { resolveContextTokensForModel } from "./context.js";

const contextTokens = resolveContextTokensForModel({
  cfg: config,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  fallbackContextTokens: 200_000
});

console.log(`Context window: ${contextTokens} tokens`);
```

### 验证上下文窗口

```typescript
import { resolveContextWindowInfo, evaluateContextWindowGuard } from "./context-window-guard.js";

const info = resolveContextWindowInfo({
  cfg: config,
  provider: "anthropic",
  modelId: "claude-sonnet-4-20250514",
  modelContextWindow: 200_000,
  defaultTokens: 200_000
});

const guard = evaluateContextWindowGuard({ info });

if (guard.shouldBlock) {
  console.error(`Context window too small: ${guard.tokens} tokens (min: ${CONTEXT_WINDOW_HARD_MIN_TOKENS})`);
  return;
}

if (guard.shouldWarn) {
  console.warn(`Context window smaller than recommended: ${guard.tokens} tokens`);
}
```

### 修复 Session

```typescript
import { repairToolUseResultPairing } from "./session-transcript-repair.js";

const repaired = repairToolUseResultPairing(messages);

console.log(`Added ${repaired.added.length} synthetic results`);
console.log(`Dropped ${repaired.droppedDuplicateCount} duplicates`);
console.log(`Dropped ${repaired.droppedOrphanCount} orphans`);
console.log(`Moved ${repaired.moved ? "yes" : "no"} results`);

const fixedMessages = repaired.messages;
```

### 获取 Session Write Lock

```typescript
import { acquireSessionWriteLock } from "./session-write-lock.js";

const lock = await acquireSessionWriteLock({
  sessionFile: "/path/to/session.jsonl",
  timeoutMs: 30_000,  // 30 秒超时
  maxHoldMs: 300_000, // 最多持有 5 分钟
});

try {
  // 写入 session 文件
  await fs.writeFile(sessionFile, data);
} finally {
  await lock.release();
}
```

---

## 相关目录

- `src/context-engine/`：上下文引擎抽象层
- `src/config/sessions/`：Session Store 管理
- `src/agents/pi-embedded-runner/compact.ts`：会话压缩
- `src/memory/`：Memory 搜索和管理
