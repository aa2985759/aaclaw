# Session Compaction

会话压缩是 OpenClaw 上下文管理的核心机制，负责在 Token 溢出时缩减会话历史。

## 目录职责

`src/agents/pi-embedded-runner/compact.ts` 实现会话压缩逻辑：

- **Token 预估**：计算当前会话的 token 使用量
- **历史修剪**：删除最旧的消息
- **摘要生成**：使用 AI 生成会话摘要
- **工具结果优化**：移除冗长的工具输出
- **并发控制**：通过 lane 队列避免死锁

---

## 核心设计

### 为什么需要压缩？

1. **Token 限制**：LLM 有固定的上下文窗口（如 Claude 200K token）
2. **成本控制**：更少的 token = 更低的 API 成本
3. **性能优化**：减少输入 token 提高响应速度
4. **内存管理**：防止会话历史无限增长

### 压缩策略

```
优先级从高到低：
1. 工具结果（toolResult）→ 删除冗长的工具输出
2. 历史消息 → 修剪最旧的会话轮次
3. 摘要生成 → 用 AI 生成摘要替代历史
```

### 设计模式

- **Strategy 模式**：通过 `ContextEngine` 接口支持不同压缩策略
- **Template Method 模式**：`compactEmbeddedPiSessionDirect` 定义压缩流程
- **Observer 模式**：before/after compaction hooks

---

## 核心流程

### 完整压缩流程

```
[触发条件]
    ↓
1. 获取 Session Write Lock
    ↓
2. 加载 Session Manager
    ↓
3. Sanitize 历史消息
    ↓
4. Validate 转次（Anthropic/Gemini 特定验证）
    ↓
5. Limit 历史轮次（DM 历史限制）
    ↓
6. Repair tool_use/tool_result 配对
    ↓
7. 触发 before_compaction hooks
    ↓
8. 执行压缩（session.compact()）
    ↓
9. 持久化到 session file
    ↓
10. 触发 after_compaction hooks
    ↓
11. 释放 Session Write Lock
```

---

## 文件详解

### 参数类型

```typescript
export type CompactEmbeddedPiSessionParams = {
  // 基础标识
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  sessionKey?: string;
  runId?: string;

  // 模型和配置
  config?: OpenClawConfig;
  provider?: string;
  model?: string;
  skillsSnapshot?: SkillSnapshot;

  // 压缩控制
  tokenBudget?: number;
  force?: boolean;
  customInstructions?: string;
  trigger?: "overflow" | "manual";

  // 子代理和权限
  spawnedBy?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  senderIsOwner?: boolean;

  // 其他
  agentAccountId?: string;
  authProfileId?: string;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
};
```

---

### 核心函数：compactEmbeddedPiSessionDirect

**函数签名：**

```typescript
export async function compactEmbeddedPiSessionDirect(
  params: CompactEmbeddedPiSessionParams
): Promise<EmbeddedPiCompactResult>
```

**返回类型：**

```typescript
export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};
```

---

## 详细实现

### 1. 初始化

```typescript
// 1.1 解析模型
const compactionModelOverride = params.config?.agents?.defaults?.compaction?.model?.trim();
let provider: string;
let modelId: string;

if (compactionModelOverride) {
  // 使用覆盖的模型（可能是 provider/model 格式）
  const slashIdx = compactionModelOverride.indexOf("/");
  provider = compactionModelOverride.slice(0, slashIdx).trim();
  modelId = compactionModelOverride.slice(slashIdx + 1).trim();
} else {
  // 使用当前会话的模型
  provider = params.provider ?? DEFAULT_PROVIDER;
  modelId = params.model ?? DEFAULT_MODEL;
}

// 1.2 解析 API Key
const apiKeyInfo = await getApiKeyForModel({
  model,
  cfg: params.config,
  profileId: authProfileId,
  agentDir,
});
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);

// 1.3 设置工作目录和沙箱
const resolvedWorkspace = resolveUserPath(params.workspaceDir);
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey,
  workspaceDir: resolvedWorkspace,
});
const effectiveWorkspace = sandbox?.enabled
  ? sandbox.workspaceAccess === "rw"
    ? resolvedWorkspace
    : sandbox.workspaceDir
  : resolvedWorkspace;
```

---

### 2. 加载 Session Manager

```typescript
// 2.1 获取 Session Write Lock
const sessionLock = await acquireSessionWriteLock({
  sessionFile: params.sessionFile,
  maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
    timeoutMs: EMBEDDED_COMPACTION_TIMEOUT_MS,
  }),
});

try {
  // 2.2 修复损坏的 session 文件
  await repairSessionFileIfNeeded({
    sessionFile: params.sessionFile,
    warn: (message) => log.warn(message),
  });

  // 2.3 预热 session file
  await prewarmSessionFile(params.sessionFile);

  // 2.4 创建 Session Manager
  const sessionManager = guardSessionManager(
    SessionManager.open(params.sessionFile),
    {
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      allowedToolNames,
    }
  );

  // 2.5 创建 Agent Session
  const { session } = await createAgentSession({
    cwd: effectiveWorkspace,
    agentDir,
    authStorage,
    modelRegistry,
    model: effectiveModel,
    thinkingLevel: mapThinkingLevel(params.thinkLevel),
    tools: builtInTools,
    customTools,
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  // ... 执行压缩
} finally {
  await sessionLock.release();
}
```

---

### 3. Sanitize 和 Validate

```typescript
// 3.1 Sanitize 历史消息
const prior = await sanitizeSessionHistory({
  messages: session.messages,
  modelApi: model.api,
  modelId,
  provider,
  allowedToolNames,
  config: params.config,
  sessionManager,
  sessionId: params.sessionId,
  policy: transcriptPolicy,
});

// 3.2 Validate Gemini 轮次
const validatedGemini = transcriptPolicy.validateGeminiTurns
  ? validateGeminiTurns(prior)
  : prior;

// 3.3 Validate Anthropic 轮次
const validated = transcriptPolicy.validateAnthropicTurns
  ? validateAnthropicTurns(validatedGemini)
  : validatedGemini;

// 3.4 应用验证后的消息到 live session
session.agent.replaceMessages(validated);
```

**为什么需要 validate？**
- Anthropic: tool_use 必须紧接 tool_result
- Gemini: 工具调用有特定的格式要求
- 某些提供商拒绝格式错误的请求

---

### 4. 历史限制

```typescript
// 4.1 应用 DM 历史限制
const originalMessages = session.messages.slice();
const truncated = limitHistoryTurns(
  session.messages,
  getDmHistoryLimitFromSessionKey(params.sessionKey, params.config)
);

// 4.2 修复 tool_use/tool_result 配对
const limited = transcriptPolicy.repairToolUseResultPairing
  ? sanitizeToolUseResultPairing(truncated)
  : truncated;

// 4.3 应用到 session
if (limited.length > 0) {
  session.agent.replaceMessages(limited);
}
```

**为什么在压缩前限制？**
- DM 场景可能有数千条历史消息
- 限制后再压缩，减少处理量

---

### 5. 触发 Before Hooks

```typescript
// 5.1 计算 token 数量
const messageCountOriginal = originalMessages.length;
let tokenCountOriginal: number | undefined;
try {
  tokenCountOriginal = 0;
  for (const message of originalMessages) {
    tokenCountOriginal += estimateTokens(message);
  }
} catch {
  tokenCountOriginal = undefined;
}

// 5.2 触发内部 hook
try {
  const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
    sessionId: params.sessionId,
    missingSessionKey,
    messageCount: messageCountBefore,
    tokenCount: tokenCountBefore,
    messageCountOriginal,
    tokenCountOriginal,
  });
  await triggerInternalHook(hookEvent);
} catch (err) {
  log.warn("session:compact:before hook failed", { errorMessage: err.message });
}

// 5.3 触发全局 hook
if (hookRunner?.hasHooks("before_compaction")) {
  try {
    await hookRunner.runBeforeCompaction(
      { messageCount: messageCountBefore, tokenCount: tokenCountBefore },
      { sessionId: params.sessionId, agentId: sessionAgentId, ... }
    );
  } catch (err) {
    log.warn("before_compaction hook failed", { errorMessage: err.message });
  }
}
```

---

### 6. 执行压缩

```typescript
// 6.1 记录压缩前指标
const preMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : undefined;
if (diagEnabled && preMetrics) {
  log.debug(
    `[compaction-diag] start sessionKey=${params.sessionKey} ` +
    `pre.messages=${preMetrics.messages} ` +
    `pre.estTokens=${preMetrics.estTokens ?? "unknown"}`
  );
}

// 6.2 检查是否有真实对话内容
if (!session.messages.some(hasRealConversationContent)) {
  log.info(`skipping — no real conversation messages (sessionKey=${params.sessionKey})`);
  return { ok: true, compacted: false, reason: "no real conversation messages" };
}

// 6.3 执行压缩
const compactStartedAt = Date.now();
const result = await compactWithSafetyTimeout(() =>
  session.compact(params.customInstructions)
);

// 6.4 计算压缩后 token
let tokensAfter: number | undefined;
try {
  tokensAfter = 0;
  for (const message of session.messages) {
    tokensAfter += estimateTokens(message);
  }
  // Sanity check: tokensAfter 应该小于 tokensBefore
  if (tokensAfter > result.tokensBefore) {
    tokensAfter = undefined;
  }
} catch {
  tokensAfter = undefined;
}

// 6.5 记录压缩后指标
const postMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : undefined;
if (diagEnabled && postMetrics) {
  log.debug(
    `[compaction-diag] end outcome=compacted ` +
    `post.messages=${postMetrics.messages} ` +
    `delta.messages=${postMetrics.messages - preMetrics.messages}`
  );
}
```

---

### 7. 触发 After Hooks

```typescript
try {
  const hookEvent = createInternalHookEvent("session", "compact:after", hookSessionKey, {
    sessionId: params.sessionId,
    messageCount: messageCountAfter,
    tokenCount: tokensAfter,
    compactedCount,
    summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
    tokensBefore: result.tokensBefore,
    tokensAfter,
    firstKeptEntryId: result.firstKeptEntryId,
  });
  await triggerInternalHook(hookEvent);
} catch (err) {
  log.warn("session:compact:after hook failed", { errorMessage: err.message });
}

if (hookRunner?.hasHooks("after_compaction")) {
  try {
    await hookRunner.runAfterCompaction(
      { messageCount: messageCountAfter, tokenCount: tokensAfter, compactedCount },
      { sessionId: params.sessionId, agentId: sessionAgentId, ... }
    );
  } catch (err) {
    log.warn("after_compaction hook failed", { errorMessage: err.message });
  }
}
```

---

## 辅助函数

### Token 预估

```typescript
function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });

    try {
      estTokens += estimateTokens(msg);
    } catch {
      // 预估失败时标记为 undefined
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens,
    contributors: contributors.toSorted((a, b) => b.chars - a.chars).slice(0, 3)
  };
}
```

---

### 压缩原因分类

```typescript
function classifyCompactionReason(reason?: string): string {
  const text = (reason ?? "").trim().toLowerCase();

  if (!text) return "unknown";
  if (text.includes("nothing to compact")) return "no_compactable_entries";
  if (text.includes("below threshold")) return "below_threshold";
  if (text.includes("already compacted")) return "already_compacted_recently";
  if (text.includes("guard")) return "guard_blocked";
  if (text.includes("summary")) return "summary_failed";
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("400") || text.includes("401") || text.includes("403") || text.includes("429")) {
    return "provider_error_4xx";
  }
  if (text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) {
    return "provider_error_5xx";
  }

  return "unknown";
}
```

---

## Lane 队列

### 为什么需要 Lane？

```typescript
// Session Lane + Global Lane 双层队列
const sessionLane = resolveSessionLane(params.sessionKey || params.sessionId);
const globalLane = resolveGlobalLane(params.lane);

return enqueueCommandInLane(sessionLane, () =>
  enqueueCommandInLane(globalLane, async () => {
    // 执行压缩
  })
);
```

**设计目的：**
- **Session Lane**：同一 session 的操作串行化
- **Global Lane**：全局操作串行化（如全局状态更新）
- **避免死锁**：防止 session lock 和 global lock 互相等待

---

## 上下文窗口解析

```typescript
// 应用 contextTokens cap
const ctxInfo = resolveContextWindowInfo({
  cfg: params.config,
  provider,
  modelId,
  modelContextWindow: model.contextWindow,
  defaultTokens: DEFAULT_CONTEXT_TOKENS,
});

// 创建 effective model
const effectiveModel =
  ctxInfo.tokens < (model.contextWindow ?? Infinity)
    ? { ...model, contextWindow: ctxInfo.tokens }
    : model;
```

**为什么需要 cap？**
- 配置限制：用户可能人为限制上下文大小
- Fail-safe：避免使用过大的上下文

---

## 系统提示词构建

```typescript
const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
  sessionKey: params.sessionKey,
  config: params.config,
});
const isDefaultAgent = sessionAgentId === defaultAgentId;
const promptMode =
  isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
    ? "minimal"
    : "full";

const appendPrompt = buildEmbeddedSystemPrompt({
  workspaceDir: effectiveWorkspace,
  defaultThinkLevel: params.thinkLevel,
  reasoningLevel: params.reasoningLevel ?? "off",
  extraSystemPrompt: params.extraSystemPrompt,
  ownerNumbers: params.ownerNumbers,
  // ...
  promptMode,
  // ...
});
```

**为什么需要 promptMode？**
- `minimal`：subagent/cron 等简化场景
- `full`：完整用户交互场景

---

## 工具过滤

```typescript
const toolsRaw = createOpenClawCodingTools({
  exec: { elevated: params.bashElevated },
  sandbox,
  messageProvider: resolvedMessageProvider,
  agentAccountId: params.agentAccountId,
  sessionKey: sandboxSessionKey,
  sessionId: params.sessionId,
  runId: params.runId,
  groupId: params.groupId,
  groupChannel: params.groupChannel,
  groupSpace: params.groupSpace,
  spawnedBy: params.spawnedBy,
  senderIsOwner: params.senderIsOwner,
  agentDir,
  workspaceDir: effectiveWorkspace,
  config: params.config,
  abortSignal: runAbortController.signal,
  modelProvider: model.provider,
  modelId,
  modelContextWindowTokens: ctxInfo.tokens,
  modelAuthMode: resolveModelAuthMode(model.provider, params.config),
});

const tools = sanitizeToolsForGoogle({
  tools: supportsModelTools(model) ? toolsRaw : [],
  provider,
});

const allowedToolNames = collectAllowedToolNames({ tools });
```

**为什么需要工具过滤？**
- 模型支持：某些模型不支持工具
- 权限控制：owner-only 工具
- 渠道限制：某些渠道不支持某些工具

---

## 错误处理

### 失败分类

```typescript
const fail = (reason: string): EmbeddedPiCompactResult => {
  log.warn(
    `[compaction-diag] end runId=${runId} ` +
    `outcome=failed reason=${classifyCompactionReason(reason)} ` +
    `durationMs=${Date.now() - startedAt}`
  );
  return { ok: false, compacted: false, reason };
};
```

### 捕获范围

```typescript
try {
  // ... 压缩逻辑
} catch (err) {
  const reason = describeUnknownError(err);
  return fail(reason);
} finally {
  restoreSkillEnv?.();
  process.chdir(prevCwd);
}
```

---

## 使用示例

### 手动触发压缩

```typescript
import { compactEmbeddedPiSession } from "./pi-embedded-runner/compact.js";

const result = await compactEmbeddedPiSession({
  sessionId: "abc-123",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  tokenBudget: 200_000,
  force: true,  // 强制压缩
  trigger: "manual"
});

if (result.compacted && result.result) {
  console.log(`Compaction reduced tokens from ${result.result.tokensBefore} to ${result.result.tokensAfter}`);
  console.log(`Summary: ${result.result.summary}`);
}
```

### 通过 Context Engine

```typescript
import { resolveContextEngine } from "./context-engine/index.js";

const engine = await resolveContextEngine(config);
const { compacted, result } = await engine.compact({
  sessionId: "abc-123",
  sessionFile: "/path/to/session.jsonl",
  tokenBudget: 200_000,
  force: false,
  customInstructions: "Focus on recent decisions and action items."
});

await engine.dispose?.();
```

---

## 相关目录

- `src/context-engine/`：上下文引擎抽象层
- `src/config/sessions/`：Session Store 管理
- `src/agents/context.ts`：上下文窗口管理
- `src/agents/context-window-guard.ts`：上下文窗口守卫
- `src/agents/session-write-lock.ts`：Session 文件写入锁
- `src/agents/pi-embedded-runner/`：Agent 运行器核心
