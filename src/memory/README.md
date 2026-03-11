# Memory Manager

Memory Manager 是 OpenClaw 的记忆搜索和向量存储系统，支持语义搜索和关键词检索。

## 目录职责

`src/memory/` 实现记忆的索引、搜索和同步：

- **索引**：将 Markdown 文件分块并生成向量嵌入
- **搜索**：语义搜索（向量）+ 关键词搜索（FTS）
- **同步**：监听文件变化，自动更新索引
- **缓存**：嵌入缓存，减少 API 调用

---

## 核心设计

### 为什么需要 Memory？

1. **长期记忆**：跨越会话边界保留信息
2. **语义检索**：通过语义相似性找到相关内容
3. **混合搜索**：结合向量搜索和关键词搜索
4. **跨会话共享**：多个会话访问同一知识库

### 搜索模式

```
1. Hybrid Mode（默认）
   向量搜索 + 关键词搜索 → 融合排序

2. FTS-Only Mode
   仅关键词搜索（无嵌入提供商时）

3. Vector-Only Mode
   仅向量搜索（FTS 不可用时）
```

### 设计模式

- **Strategy 模式**：不同的嵌入提供商（OpenAI、Gemini、Voyage、Ollama）
- **Repository 模式**：SQLite 存储文件和 chunk
- **Observer 模式**：文件监听触发同步
- **Caching 模式**：嵌入缓存 + 批处理

---

## 核心架构

```
Memory Index Manager
    ↓
┌──────────────────────────────────────────┐
│  Provider (Embedding)               │
│  - OpenAI / Gemini / Voyage / Ollama │
│  - Fallback: local (sqlite-vec)     │
└──────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────┐
│  SQLite Database                     │
│  - files: 文件元数据                │
│  - chunks: 文本块 + 向量             │
│  - chunks_fts: FTS 索引            │
│  - embedding_cache: 嵌入缓存         │
└──────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────┐
│  Watcher (chokidar)                │
│  - 监听 memory/, memory/*.md         │
│  - 触发 sync()                     │
└──────────────────────────────────────────┘
```

---

## 核心类型

### MemorySearchResult

```typescript
type MemorySearchResult = {
  id: string;           // chunk ID
  path: string;          // 文件路径（相对于 workspace）
  startLine: number;     // 起始行号
  endLine: number;       // 结束行号
  snippet: string;        // 文本片段（最多 700 字符）
  score: number;         // 相关性得分 [0, 1]
  source: MemorySource;  // 来源类型
  citation?: string;      // 引用格式（path#L1-L5）
};
```

### MemorySource

```typescript
type MemorySource =
  | "memory"     // MEMORY.md
  | "memory-file"; // memory/*.md
```

### MemorySearchManager

```typescript
interface MemorySearchManager {
  // 搜索
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    }
  ): Promise<MemorySearchResult[]>;

  // 读取文件
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;

  // 同步
  sync(opts?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;

  // 状态
  status(): MemoryProviderStatus;

  // 关闭
  close(): Promise<void>;
}
```

---

## 文件详解

### `manager.ts`

核心实现类 `MemoryIndexManager`。

#### 类结构

```typescript
export class MemoryIndexManager extends MemoryManagerEmbeddingOps
  implements MemorySearchManager
{
  // 配置
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;

  // 嵌入提供商
  protected provider: EmbeddingProvider | null;
  protected readonly requestedProvider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "auto";
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected fallbackReason?: string;

  // 数据库
  protected db: DatabaseSync;

  // 向量和 FTS
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };

  // 文件监听
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;

  // 状态
  protected closed = false;
  protected dirty = false;
  protected syncing: Promise<void> | null = null;
}
```

---

### 获取实例

```typescript
static async get(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager | null> {
  const settings = resolveMemorySearchConfig(cfg, agentId);
  if (!settings) {
    return null;
  }

  // 缓存 key: agentId + workspaceDir + settings
  const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
  const existing = INDEX_CACHE.get(key);
  if (existing) {
    return existing;
  }

  // 创建嵌入提供商
  const providerResult = await createEmbeddingProvider({
    config: cfg,
    agentDir: resolveAgentDir(cfg, agentId),
    provider: settings.provider,
    remote: settings.remote,
    model: settings.model,
    fallback: settings.fallback,
    local: settings.local,
  });

  const manager = new MemoryIndexManager({
    cacheKey: key,
    cfg,
    agentId,
    workspaceDir,
    settings,
    providerResult,
    purpose: params.purpose,
  });

  INDEX_CACHE.set(key, manager);
  return manager;
}
```

**为什么需要缓存？**
- 避免重复创建
- 相同配置共享实例
- 减少资源消耗

---

## 核心功能

### 1. 搜索

```typescript
async search(
  query: string,
  opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }
): Promise<MemorySearchResult[]> {
  // 1. 预热 session（如果配置了 onSessionStart）
  void this.warmSession(opts?.sessionKey);

  // 2. 同步（如果配置了 onSearch）
  if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
    void this.sync({ reason: "search" }).catch(() => {});
  }

  // 3. FTS-Only 模式（无嵌入提供商）
  if (!this.provider) {
    return this.searchFtsOnly(query, opts);
  }

  // 4. 关键词搜索
  const keywordResults =
    this.settings.query.hybrid.enabled && this.fts.enabled && this.fts.available
      ? await this.searchKeyword(query, candidates)
      : [];

  // 5. 向量搜索
  const queryVec = await this.embedQueryWithTimeout(query);
  const vectorResults = hasVector
    ? await this.searchVector(queryVec, candidates)
    : [];

  // 6. Hybrid 融合
  if (!this.settings.query.hybrid.enabled || !this.fts.enabled || !this.fts.available) {
    return vectorResults.filter(entry => entry.score >= minScore).slice(0, maxResults);
  }

  const merged = await this.mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: hybrid.vectorWeight,
    textWeight: hybrid.textWeight,
    mmr: hybrid.mmr,
    temporalDecay: hybrid.temporalDecay,
  });

  return merged
    .filter(entry => entry.score >= minScore)
    .slice(0, maxResults);
}
```

#### 搜索策略对比

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **Vector-Only** | 语义理解强 | 无法精确匹配术语 | 概念性查询 |
| **FTS-Only** | 精确匹配 | 无语义理解 | 精确术语 |
| **Hybrid** | 结合两者优势 | 复杂度高 | 通用场景 |

#### MMR（Maximal Marginal Relevance）

```typescript
mmr: {
  enabled: boolean;
  lambda: number;  // [0, 1]，0 = 多样性优先，1 = 相关性优先
}
```

**目的：** 避免返回过于相似的结果，增加结果多样性。

#### Temporal Decay（时间衰减）

```typescript
temporalDecay: {
  enabled: boolean;
  halfLifeDays: number;  // 半衰期（天数）
}
```

**目的：** 旧内容得分衰减，偏好新内容。

---

### 2. 同步

```typescript
async sync(opts?: {
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<void> {
  if (this.syncing) {
    return this.syncing;  // 避免并发同步
  }

  this.syncing = this.runSyncWithReadonlyRecovery(opts).finally(() => {
    this.syncing = null;
  });

  return this.syncing;
}

private async runSyncWithReadonlyRecovery(opts?: { ... }): Promise<void> {
  try {
    await this.runSync(opts);
  } catch (err) {
    // 检测只读数据库错误
    if (this.isReadonlyDbError(err)) {
      log.warn("memory sync readonly handle detected; reopening sqlite connection");
      // 重新打开数据库
      this.db.close();
      this.db = this.openDatabase();
      this.vectorReady = null;
      this.ensureSchema();
      // 重试同步
      await this.runSync(opts);
    } else {
      throw err;
    }
  }
}
```

**同步流程：**
1. 扫描 memory/ 和 memory/*.md
2. 计算文件哈希
3. 对比数据库中的记录
4. 增量更新：
   - 新文件：插入 chunks + 嵌入
   - 修改的文件：更新 chunks + 嵌入
   - 删除的文件：从数据库删除
5. 触发进度回调

---

### 3. 读取文件

```typescript
async readFile(params: {
  relPath: string;
  from?: number;   // 起始行号（1-based）
  lines?: number;  // 行数
}): Promise<{ text: string; path: string }> {
  const absPath = path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(this.workspaceDir, relPath);
  const relPathNormalized = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");

  // 1. 验证路径
  const inWorkspace =
    relPathNormalized.length > 0 &&
    !relPathNormalized.startsWith("..") &&
    !path.isAbsolute(relPathNormalized);
  const allowedWorkspace = inWorkspace && isMemoryPath(relPathNormalized);

  // 2. 验证额外路径
  let allowedAdditional = false;
  if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
    const additionalPaths = normalizeExtraMemoryPaths(
      this.workspaceDir,
      this.settings.extraPaths
    );
    for (const additionalPath of additionalPaths) {
      const stat = await fs.lstat(additionalPath);
      if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
        allowedAdditional = true;
        break;
      }
    }
  }

  if (!allowedWorkspace && !allowedAdditional) {
    throw new Error("path required");
  }

  // 3. 读取文件
  const content = await fs.readFile(absPath, "utf8");

  // 4. 支持分页
  if (!params.from && !params.lines) {
    return { text: content, path: relPathNormalized };
  }

  const lines = content.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const count = Math.max(1, params.lines ?? lines.length);
  const slice = lines.slice(start - 1, start - 1 + count);
  return { text: slice.join("\n"), path: relPathNormalized };
}
```

**安全检查：**
- 路径必须在 workspace 或 extraPaths 内
- 路径不能是绝对路径
- 路径不能包含 `..`
- 路径必须以 `.md` 结尾

---

### 4. 状态查询

```typescript
status(): MemoryProviderStatus {
  // 统计文件和 chunks
  const files = this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
  const chunks = this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number };

  // 源分类统计
  const sourceCounts = this.buildSourceCounts();

  // 搜索模式
  const searchMode = this.provider ? "hybrid" : "fts-only";

  // 嵌入提供商信息
  const providerInfo = this.provider
    ? { provider: this.provider.id, model: this.provider.model }
    : { provider: "none", model: undefined };

  return {
    backend: "builtin",
    files: files?.c ?? 0,
    chunks: chunks?.c ?? 0,
    dirty: this.dirty || this.sessionsDirty,
    workspaceDir: this.workspaceDir,
    dbPath: this.settings.store.path,
    provider: providerInfo.provider,
    model: providerInfo.model,
    requestedProvider: this.requestedProvider,
    sources: Array.from(this.sources),
    extraPaths: this.settings.extraPaths,
    sourceCounts,
    cache: {
      enabled: this.cache.enabled,
      entries: this.getCacheEntryCount(),
      maxEntries: this.cache.maxEntries,
    },
    fts: {
      enabled: this.fts.enabled,
      available: this.fts.available,
      error: this.fts.loadError,
    },
    fallback: this.fallbackReason
      ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
      : undefined,
    vector: {
      enabled: this.vector.enabled,
      available: this.vector.available ?? undefined,
      extensionPath: this.vector.extensionPath,
      loadError: this.vector.loadError,
      dims: this.vector.dims,
    },
    batch: {
      enabled: this.batch.enabled,
      failures: this.batchFailureCount,
      limit: BATCH_FAILURE_LIMIT,
      wait: this.batch.wait,
      concurrency: this.batch.concurrency,
      pollIntervalMs: this.batch.pollIntervalMs,
      timeoutMs: this.batch.timeoutMs,
      lastError: this.batchFailureLastError,
      lastProvider: this.batchFailureLastProvider,
    },
    custom: {
      searchMode,
      providerUnavailableReason: this.providerUnavailableReason,
      readonlyRecovery: {
        attempts: this.readonlyRecoveryAttempts,
        successes: this.readonlyRecoverySuccesses,
        failures: this.readonlyRecoveryFailures,
        lastError: this.readonlyRecoveryLastError,
      },
    },
  };
}
```

---

## 数据库 Schema

### 文件表（files）

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,           -- "memory" or "memory-file"
  path TEXT NOT NULL,             -- 相对于 workspace 的路径
  hash TEXT NOT NULL,             -- 文件内容哈希
  size INTEGER NOT NULL,           -- 文件大小（字节）
  updated_at INTEGER NOT NULL,     -- 最后更新时间
  UNIQUE(source, path)
);
```

### Chunks 表（chunks）

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,        -- 外键到 files.id
  start_line INTEGER NOT NULL,      -- 起始行号
  end_line INTEGER NOT NULL,        -- 结束行号
  text TEXT NOT NULL,              -- 文本内容
  provider TEXT NOT NULL,          -- 嵌入提供商
  model TEXT NOT NULL,             -- 嵌入模型
  updated_at INTEGER NOT NULL,      -- 嵌入时间
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
```

### 向量表（chunks_vec）

```sql
-- 使用 sqlite-vec 扩展
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  embedding FLOAT[1536],          -- OpenAI 默认 1536 维
  chunk_id INTEGER PRIMARY KEY,     -- 外键到 chunks.id
  chunk_text TEXT NOT NULL,        -- 文本内容（用于 snippet）
  start_line INTEGER NOT NULL,      -- 起始行号
  end_line INTEGER NOT NULL,        -- 结束行号
  path TEXT NOT NULL,             -- 文件路径
  source TEXT NOT NULL,           -- 来源类型
);
```

### FTS 表（chunks_fts）

```sql
-- 全文搜索索引
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,                          -- 文本内容
  start_line,                     -- 起始行号
  end_line,                       -- 结束行号
  path,                          -- 文件路径
  source,                        -- 来源类型
  tokenize = "unicode61"          -- Unicode 分词
);
```

### 嵌入缓存表（embedding_cache）

```sql
CREATE TABLE embedding_cache (
  text TEXT PRIMARY KEY,            -- 原始文本
  provider TEXT NOT NULL,          -- 嵌入提供商
  model TEXT NOT NULL,             -- 嵌入模型
  embedding BLOB NOT NULL,          -- 序列化的向量
  created_at INTEGER NOT NULL
);
```

---

## 批处理和错误恢复

### 批处理配置

```typescript
protected readonly batch = {
  enabled: boolean;        // 是否启用批处理
  wait: boolean;          // 等待策略
  concurrency: number;    // 并发数
  pollIntervalMs: number; // 轮询间隔
  timeoutMs: number;      // 超时时间
};
```

### 失败限制

```typescript
const BATCH_FAILURE_LIMIT = 2;

protected batchFailureCount = 0;
protected batchFailureLastError?: string;
protected batchFailureLastProvider?: string;
```

**策略：**
- 失败次数超过限制时，禁用批处理
- 记录最后错误和提供商
- 提供诊断信息

---

## 文件监听

### 监听范围

```typescript
this.ensureWatcher();

private ensureWatcher(): void {
  // 监听 memory/ 和 memory/*.md
  const watchPaths = [this.workspaceDir];
  if (this.settings.extraPaths.length > 0) {
    watchPaths.push(...this.settings.extraPaths);
  }

  this.watcher = chokidar.watch(watchPaths, {
    ignored: /(^|[\/\\])\../,  // 忽略隐藏文件
    persistent: true,
  });

  // 文件变化时标记 dirty
  this.watcher.on("all", (event, path) => {
    if (isMemoryPath(path)) {
      this.dirty = true;
    }
  });
}
```

---

## 关闭和清理

```typescript
async close(): Promise<void> {
  if (this.closed) {
    return;
  }
  this.closed = true;

  // 取消定时器
  if (this.watchTimer) clearTimeout(this.watchTimer);
  if (this.intervalTimer) clearInterval(this.intervalTimer);

  // 关闭文件监听
  if (this.watcher) {
    await this.watcher.close();
  }

  // 等待同步完成
  const pendingSync = this.syncing;
  if (pendingSync) {
    await pendingSync;
  }

  // 关闭数据库
  this.db.close();
  INDEX_CACHE.delete(this.cacheKey);
}
```

---

## 使用示例

### 搜索记忆

```typescript
import { getMemorySearchManager } from "./index.js";

const { manager, error } = await getMemorySearchManager({ cfg, agentId });
if (!manager) {
  console.error("Memory not available:", error);
  return;
}

const results = await manager.search("What did we discuss about the API?", {
  maxResults: 10,
  minScore: 0.3,
  sessionKey: "telegram:user@example.com"
});

for (const result of results) {
  console.log(`[${result.score.toFixed(2)}] ${result.path}:${result.startLine}-${result.endLine}`);
  console.log(result.snippet);
  console.log();
}

await manager.close();
```

### 读取文件

```typescript
const { text, path } = await manager.readFile({
  relPath: "memory/design-decisions.md",
  from: 10,
  lines: 5
});

console.log(`${path} (lines 10-15):`);
console.log(text);
```

### 同步

```typescript
await manager.sync({
  reason: "manual",
  progress: (update) => {
    console.log(`Progress: ${update.percent.toFixed(1)}%`);
    console.log(`  ${update.currentAction}`);
  }
});
```

---

## 配置

### 基本配置

```yaml
memory:
  # 搜索配置
  search:
    hybrid:
      enabled: true
      vectorWeight: 0.7
      textWeight: 0.3
      mmr:
        enabled: true
        lambda: 0.5
      temporalDecay:
        enabled: false
        halfLifeDays: 30
    maxResults: 10
    minScore: 0.35

  # 存储配置
  store:
    path: ~/.openclaw/memory/index.db
    vector:
      enabled: true
      extensionPath: ~/.openclaw/vec0.so

  # 同步配置
  sync:
    onSessionStart: true
    onSearch: false
    intervalMs: 60000  # 1 分钟

  # 嵌入提供商
  provider: openai
  model: text-embedding-3-small
  remote: false
  fallback: local

  # 缓存
  cache:
    enabled: true
    maxEntries: 10000
```

---

## 相关目录

- `src/agents/tools/memory-tool.ts`：Memory 工具（memory_search / memory_get）
- `src/config/sessions/`：Session Store 管理
- `src/context-engine/`：上下文引擎
