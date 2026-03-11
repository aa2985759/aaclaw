# Session Store

Session Store 是 OpenClaw 的会话存储核心，负责管理所有会话的元数据和生命周期。

## 目录职责

`src/config/sessions/` 负责会话的持久化、查询、维护和并发控制：

- **存储**：Session 元数据的 JSON 文件存储（session-store.json）
- **查询**：根据 sessionKey 查找/更新会话
- **维护**：清理过期会话、归档旧记录、磁盘预算管理
- **并发控制**：写入锁 + 队列机制，防止并发冲突

---

## 核心设计

### 为什么需要 Session Store？

1. **会话隔离**：每个 conversation 有独立的 SessionEntry
2. **跨进程持久化**：进程重启后恢复会话状态
3. **元数据丰富**：存储模型、工具、配置等运行时状态
4. **自动维护**：自动清理过期会话，防止无限增长

### 设计模式

- **Repository 模式**：store.ts 是单一数据访问层
- **Unit of Work 模式**：`updateSessionStore` 在锁内完成读写事务
- **Strategy 模式**：不同维护策略（prune/cap/rotate）
- **Observer 模式**：文件监听 + Session 事件触发同步

---

## 文件说明

### `types.ts`

定义 `SessionEntry` 及所有相关类型。

#### 核心类型：SessionEntry

```typescript
type SessionEntry = {
  // 基础标识
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;

  // 子代理支持
  spawnedBy?: string;        // 父会话
  forkedFromParent?: boolean; // 是否从父会话 fork 过
  spawnDepth?: number;       // 嵌套深度
  subagentRole?: "orchestrator" | "leaf";
  subagentControlScope?: "children" | "none";

  // 上下文相关
  contextTokens?: number;    // 上下文窗口大小
  compactionCount?: number;   // 压缩次数
  totalTokens?: number;       // 累计 token 使用
  totalTokensFresh?: boolean; // totalTokens 是否为最新值

  // 运行时模型
  modelProvider?: string;
  model?: string;

  // 交付上下文
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;

  // 配置和策略
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  ttsAuto?: TtsAutoMode;
  queueMode?: "steer" | "followup" | "collect" | "queue" | "interrupt";
  sendPolicy?: "allow" | "deny";

  // Token 使用统计
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;

  // ACP 集成
  acp?: SessionAcpMeta;

  // ... 其他字段
};
```

#### 关键辅助函数

| 函数 | 用途 |
|------|------|
| `mergeSessionEntry(existing, patch)` | 合并补丁到现有会话，更新 updatedAt |
| `mergeSessionEntryPreserveActivity(existing, patch)` | 合并但保留 updatedAt（用于入站更新） |
| `normalizeSessionRuntimeModelFields(entry)` | 规范化 model/modelProvider 字段 |
| `resolveFreshSessionTotalTokens(entry)` | 判断 totalTokens 是否为新鲜值 |
| `isSessionTotalTokensFresh(entry)` | 同上，boolean 形式 |

---

### `store.ts`

Session Store 核心实现，约 884 行。

#### 核心功能

##### 1. 存储和缓存

```typescript
// 默认缓存 TTL 45 秒
const DEFAULT_SESSION_STORE_TTL_MS = 45_000;

function loadSessionStore(
  storePath: string,
  opts?: { skipCache?: boolean }
): Record<string, SessionEntry> {
  // 1. 检查内存缓存（如果启用）
  const cached = readSessionStoreCache({ storePath, ttlMs: 45_000 });
  if (cached) return cached;

  // 2. 从磁盘加载（Windows 重试 3 次，避免锁竞争）
  let store: Record<string, SessionEntry> = {};
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  for (let attempt = 0; attempt < maxReadAttempts; attempt++) {
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      store = JSON.parse(raw);
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf, 0, 0, 50); // 等待 50ms
      }
    }
  }

  // 3. 应用迁移
  applySessionStoreMigrations(store);

  // 4. 写入缓存
  writeSessionStoreCache({ storePath, store });

  return structuredClone(store);
}
```

**为什么需要缓存？**
- 减少磁盘 I/O
- 45 秒 TTL 平衡性能和一致性
- 使用 `structuredClone` 避免返回可变引用

**为什么 Windows 需要重试？**
- Windows 文件锁：`rename` 原子写不是完全原子的
- 并发读取器可能观察到 0 字节文件
- 短暂退避（50ms）让写入者完成

##### 2. 并发控制：写入锁 + 队列

```typescript
// 每个文件一个队列
const LOCK_QUEUES = new Map<string, SessionStoreLockQueue>();

type SessionStoreLockQueue = {
  running: boolean;
  pending: SessionStoreLockTask[];
};

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const queue = getOrCreateLockQueue(storePath);
  const timeoutMs = 10_000;

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn,
      resolve,
      reject,
      timeoutMs,
      staleMs: 30_000
    };
    queue.pending.push(task);
    void drainSessionStoreLockQueue(storePath);  // 立即触发队列处理
  });

  return await promise;
}
```

**设计优势：**
- **公平调度**：FIFO 队列
- **避免死锁**：串行化对同一文件的访问
- **超时保护**：10 秒超时后抛错
- **自动清理**：队列为空时删除队列对象

##### 3. 核心 API

| 函数 | 用途 |
|------|------|
| `loadSessionStore(storePath, opts?)` | 加载 store（支持缓存） |
| `saveSessionStore(storePath, store, opts?)` | 保存 store（自动维护） |
| `updateSessionStore(storePath, mutator, opts?)` | 在锁内更新 store |
| `updateSessionStoreEntry(params)` | 更新单个 session entry |
| `recordSessionMetaFromInbound(params)` | 记录入站消息的元数据 |
| `updateLastRoute(params)` | 更新最后路由信息 |

##### 4. Session Key 解析

```typescript
function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;  // 小写 trim 后
  existing: SessionEntry | undefined;
  legacyKeys: string[];  // 旧格式 key（需要删除）
}
```

**为什么需要 legacyKeys？**
- 支持旧格式 key（如大小写混合）
- 自动迁移到新格式（小写）
- 迁移后删除旧 key

##### 5. 维护：Prune / Cap / Rotate

```typescript
type SessionMaintenanceApplyReport = {
  mode: "enforce" | "warn";
  beforeCount: number;
  afterCount: number;
  pruned: number;        // 删除的过期会话数
  capped: number;         // 裁剪的会话数（总数上限）
  diskBudget: SessionDiskBudgetSweepResult;  // 磁盘预算清理结果
};

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions
): Promise<void> {
  if (!opts?.skipMaintenance) {
    const maintenance = resolveMaintenanceConfig();

    // 1. Prune 过期会话
    const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs);

    // 2. Cap 总数
    const capped = capEntryCount(store, maintenance.maxEntries);

    // 3. 归档已删除会话的 transcript
    const archivedDirs = archiveRemovedSessionTranscripts({
      removedSessionFiles,
      referencedSessionIds
    });

    // 4. 旋转 store 文件（如果超过大小限制）
    await rotateSessionFile(storePath, maintenance.rotateBytes);

    // 5. 执行磁盘预算
    const diskBudget = await enforceSessionDiskBudget({
      store,
      storePath,
      maintenance
    });
  }

  // 6. 持久化
  await writeSessionStoreAtomic({ storePath, store, serialized: json });
}
```

**维护策略：**

| 策略 | 触发条件 | 操作 |
|------|-----------|------|
| `pruneStaleEntries` | 会话超过 `pruneAfterMs` 未更新 | 删除过期会话 |
| `capEntryCount` | 会话总数超过 `maxEntries` | 删除最旧的会话 |
| `rotateSessionFile` | store 文件超过 `rotateBytes` | 重命名为 `.old`，创建新文件 |
| `enforceSessionDiskBudget` | 磁盘使用超过预算 | 删除最旧的 transcript 文件 |

##### 6. 交付上下文（Delivery Context）

```typescript
export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  // ...
}) {
  // 合并显式上下文 + 内联上下文 + 回退上下文
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel, to, accountId, threadId
  });
  const fallbackContext = deliveryContextFromSession(existing);
  const merged = mergeDeliveryContext(
    mergeDeliveryContext(explicitContext, inlineContext),
    fallbackContext
  );

  // 持久化
  return await persistResolvedSessionEntry({ ... });
}
```

**为什么需要三层合并？**
- `explicitContext`：外部传入的优先级最高
- `inlineContext`：参数中直接指定的次之
- `fallbackContext`：会话中已有的最低

---

### `transcript.ts`

Session transcript（会话记录）管理。

#### 核心功能

```typescript
// 追加助手消息到 transcript
export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }>
```

**用途：**
- 用于镜像助手回复到 transcript
- 支持文本和媒体 URL
- 自动提取文件名作为文本

**为什么需要？**
- 某些消息渠道不自动记录助手回复
- 确保历史完整性

---

### `paths.ts`

路径解析工具。

#### 核心函数

```typescript
// 默认 session store 路径
export function resolveDefaultSessionStorePath(agentId?: string): string {
  const base = resolveOpenClawDataDir();
  return path.join(base, "sessions", "session-store.json");
}

// session 文件路径
export function resolveSessionFilePath(
  sessionId: string,
  entry?: SessionEntry,
  opts?: ResolveSessionFilePathOptions
): string {
  if (entry?.sessionFile) {
    return entry.sessionFile;
  }
  // 默认路径: ~/.openclaw/sessions/<sessionId>.jsonl
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}
```

---

### `metadata.ts`

从 `MsgContext` 派生 Session 元数据补丁。

#### 核心函数

```typescript
export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null
```

**派生字段：**
- `channel`, `groupId`, `subject`
- `origin.provider`, `origin.surface`
- `deliveryContext`
- 其他从消息上下文派生的字段

---

### `session-file.ts`

Session 文件处理（持久化 + 查找）。

#### 核心功能

```typescript
// 持久化 sessionFile 到 SessionEntry
export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }>
```

**逻辑：**
1. 如果 `sessionEntry.sessionFile` 已存在，直接使用
2. 否则，根据 `fallbackSessionFile` 或默认规则查找
3. 持久化到 `sessionStore`

---

### `store-maintenance.ts`

会话维护策略：prune / cap / rotate。

#### 核心策略

```typescript
export type ResolvedSessionMaintenanceConfig = {
  mode: "enforce" | "warn";        // 强制执行或仅警告
  pruneAfterMs: number;              // 多久后 prune（默认 30 天）
  maxEntries: number;                // 最大会话数（默认 100）
  rotateBytes: number;               // 多大后 rotate（默认 10 MB）
  resetArchiveRetentionMs?: number;   // reset 归档保留多久（可选）
};
```

##### Prune（删除过期）

```typescript
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  pruneAfterMs: number,
  opts?: {
    onPruned?: (params: { entry: SessionEntry }) => void;
  }
): number {
  const now = Date.now();
  let pruned = 0;

  for (const [key, entry] of Object.entries(store)) {
    const lastActivity = entry.updatedAt ?? 0;
    if (now - lastActivity > pruneAfterMs) {
      delete store[key];
      opts?.onPruned?.({ entry });
      pruned++;
    }
  }

  return pruned;
}
```

##### Cap（总数上限）

```typescript
export function capEntryCount(
  store: Record<string, SessionEntry>,
  maxEntries: number,
  opts?: {
    onCapped?: (params: { entry: SessionEntry }) => void;
  }
): number {
  const entries = Object.entries(store);
  if (entries.length <= maxEntries) return 0;

  // 按 updatedAt 排序，删除最旧的
  entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  const toRemove = entries.slice(0, entries.length - maxEntries);

  for (const [key, entry] of toRemove) {
    delete store[key];
    opts?.onCapped?.({ entry });
  }

  return toRemove.length;
}
```

##### Rotate（文件轮转）

```typescript
export async function rotateSessionFile(
  storePath: string,
  rotateBytes: number
): Promise<void> {
  const stat = await fs.stat(storePath);
  if (stat.size < rotateBytes) return;

  const archivePath = `${storePath}.old`;
  await fs.rename(storePath, archivePath);
  // 新文件将在下次 save 时创建
}
```

---

### `disk-budget.ts`

磁盘预算管理，防止会话数据无限增长。

#### 核心逻辑

```typescript
export async function enforceSessionDiskBudget(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  activeSessionKey?: string;
  maintenance: ResolvedSessionMaintenanceConfig;
  warnOnly?: boolean;
  log?: Logger;
}): Promise<SessionDiskBudgetSweepResult>
```

**策略：**
1. 扫描 transcript 目录
2. 按 updatedAt 排序
3. 删除最旧的文件，直到总大小低于预算
4. 活跃会话受保护

---

### `delivery-info.ts`

交付信息解析。

```typescript
export function parseSessionThreadInfo(sessionKey: string): {
  channel?: string;
  id?: string;
  threadId?: string | number;
}
```

---

### `group.ts`

群组会话管理。

---

## Session 生命周期

```
[首次消息]
    ↓
recordSessionMetaFromInbound() → 创建 SessionEntry
    ↓
updateSessionStoreEntry() → 持久化
    ↓
[每次交互]
    ↓
updateSessionStoreEntry() → 更新 updatedAt
    ↓
[Token 溢出]
    ↓
compactEmbeddedPiSession() → 压缩 → 更新 compactionCount
    ↓
[定期维护]
    ↓
pruneStaleEntries() → 删除过期
    ↓
capEntryCount() → 限制总数
    ↓
rotateSessionFile() → 轮转文件
    ↓
enforceSessionDiskBudget() → 磁盘预算
```

---

## 并发控制详解

### 写入锁（File Lock）

```typescript
// 每个文件一个锁文件
const lockPath = `${sessionFile}.lock`;

// PID 检测避免误删
const payload = {
  pid: process.pid,
  createdAt: new Date().toISOString(),
  starttime: getProcessStartTime(process.pid)  // 防止 PID 复用
};
```

### 队列（Task Queue）

```typescript
type SessionStoreLockTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutMs?: number;
  staleMs: number;
};
```

**流程：**
1. 任务推入队列
2. `drainSessionStoreLockQueue` 串行执行
3. 超时后 reject
4. 任务完成后触发下一个

---

## 缓存策略

### Session Store Cache

```typescript
// 内存缓存：Map<storePath, { store, mtimeMs, sizeBytes }>
// TTL: 45 秒（可通过 OPENCLAW_SESSION_CACHE_TTL_MS 调整）

function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void
```

**失效条件：**
- TTL 过期
- 文件 mtime 变化
- 文件大小变化

---

## 迁移机制

### Session Store Migrations

```typescript
export function applySessionStoreMigrations(
  store: Record<string, SessionEntry>
): void
```

**用途：**
- 添加新字段
- 修改旧字段格式
- 删除废弃字段

**示例：**
```typescript
// 迁移 1: 添加 totalTokensFresh 字段
if (entry.totalTokensFresh === undefined) {
  entry.totalTokensFresh = false;
}
```

---

## 配置

### 维护配置

```yaml
agents:
  defaults:
    sessionMaintenance:
      mode: "enforce"  # 或 "warn"
      pruneAfterDays: 30
      maxEntries: 100
      rotateBytes: 10485760  # 10 MB
```

### 磁盘预算

```yaml
memory:
  diskBudgetMB: 1024  # 1 GB
```

---

## 使用示例

### 查询会话

```typescript
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";

const store = loadSessionStore(storePath);
const { normalizedKey, existing } = resolveSessionStoreEntry({
  store,
  sessionKey: "telegram:user@example.com"
});

console.log(existing);
```

### 更新会话

```typescript
import { updateSessionStoreEntry } from "./store.js";

const updated = await updateSessionStoreEntry({
  storePath,
  sessionKey: "telegram:user@example.com",
  update: (entry) => {
    return {
      compactionCount: (entry.compactionCount ?? 0) + 1,
      totalTokens: (entry.totalTokens ?? 0) + 5000
    };
  }
});
```

### 原子更新

```typescript
import { updateSessionStore } from "./store.js";

const newModel = await updateSessionStore(
  storePath,
  async (store) => {
    const entry = store[sessionKey];
    if (!entry) return null;
    entry.model = "claude-sonnet-4-20250514";
    entry.modelProvider = "anthropic";
    return entry;
  }
);
```

---

## 相关目录

- `src/agents/pi-embedded-runner/compact.ts`：会话压缩
- `src/context-engine/`：上下文引擎
- `src/memory/`：Memory 搜索和管理
- `src/agents/session-write-lock.ts`：Session 文件写入锁
