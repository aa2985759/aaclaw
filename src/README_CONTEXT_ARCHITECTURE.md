# Context Management Architecture

OpenClaw 上下文管理架构总览。本文档汇总了所有上下文相关的目录和它们之间的关系。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw Context                     │
└─────────────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Context Engine    │  │  Session Store   │  │   Memory        │
│ (抽象层）         │  │  (元数据存储）    │  │  (长期记忆）     │
│                  │  │                  │  │                  │
│ - ingest        │  │ - load/save      │  │ - 索引         │
│ - assemble      │  │ - 维护（prune/ │  │ - 搜索         │
│ - compact      │  │   cap/rotate）   │  │ - 同步          │
│ - afterTurn    │  │ - 并发控制       │  │ - 嵌入缓存     │
└──────────────────┘  └──────────────────┘  └──────────────────┘
         │                 │                 │
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ Agent Runner     │
                  │ (执行层）        │
                  │                  │
                  │ - compact()      │
                  │ - search()       │
                  │ - 文件锁         │
                  └──────────────────┘
```

---

## 目录职责总结

| 目录 | 核心职责 | 输出 |
|------|----------|------|
| `src/context-engine/` | 上下文管理抽象层 | ContextEngine 接口和实现 |
| `src/config/sessions/` | Session 元数据存储和生命周期 | SessionEntry CRUD + 维护 |
| `src/agents/pi-embedded-runner/`（compact.ts） | 会话压缩执行 | 压缩结果 + session 更新 |
| `src/agents/`（context*.ts） | 上下文窗口和并发控制 | Token 预估 + 写入锁 |
| `src/memory/` | 长期记忆和语义搜索 | MemorySearchResult[] |

---

## 数据流向

### 1. 消息处理流程

```
[用户消息]
    ↓
Channel: 接收消息
    ↓
ContextEngine.ingest(message)
    ↓
Session Store: 更新 SessionEntry.updatedAt
    ↓
ContextEngine.assemble({ messages, tokenBudget })
    ↓
Agent Runner: 调用 LLM API
    ↓
[LLM 响应]
    ↓
Session Store: 更新 totalTokens, compactionCount
    ↓
ContextEngine.afterTurn(messages)
    ↓
[检查是否需要压缩？]
    ↓
    ├─ 是 → ContextEngine.compact()
    │           ↓
    │       压缩会话（生成摘要/修剪历史）
    │           ↓
    │       持久化到 session 文件
    │
    └─ 否 → [完成]
```

### 2. 压缩触发流程

```
[Token 使用超限]
    ↓
Agent Runner: 检测溢出
    ↓
ContextEngine.compact({ sessionId, sessionFile, tokenBudget })
    ↓
┌───────────────────────────────────────┐
│ 压缩策略                          │
│                                   │
│ 1. 获取 Session Write Lock         │
│ 2. 加载 Session Manager            │
│ 3. Sanitize 历史消息             │
│ 4. 限制历史轮次（DM 历史限制）   │
│ 5. Repair tool_use/tool_result     │
│ 6. 触发 before_compaction hooks   │
│ 7. 执行压缩（生成摘要）           │
│ 8. 触发 after_compaction hooks    │
│ 9. 释放 Session Write Lock         │
└───────────────────────────────────────┘
    ↓
Session Store: 更新 compactionCount, contextTokens
    ↓
[压缩完成]
```

### 3. Memory 搜索流程

```
[用户查询]
    ↓
Agent: memory_search(query)
    ↓
Memory Manager:
    ↓
┌───────────────────────────────────────┐
│ 搜索策略                          │
│                                   │
│ 1. 预热 Session（可选）          │
│ 2. 同步（可选）                  │
│ 3. 提取关键词                     │
│ 4. 嵌入查询（向量）             │
│ 5. 关键词搜索（FTS）            │
│ 6. 向量搜索（vec0）              │
│ 7. Hybrid 融合排序                │
│ 8. MMR 多样化（可选）            │
│ 9. Temporal Decay（可选）         │
│ 10. 过滤和分页                  │
└───────────────────────────────────────┘
    ↓
返回: MemorySearchResult[]
    ↓
[Agent 使用结果]
```

---

## 核心概念

### 上下文窗口（Context Window）

- **定义**：LLM 一次调用能接受的最大 token 数
- **来源**：
  1. 模型内建（如 Claude 200K）
  2. 配置覆盖（config.agents.defaults.contextTokens）
  3. 模型配置（config.models.providers.<provider>.models[].contextWindow）
- **用途**：计算 token 预算，触发压缩

### Session（会话）

- **定义**：一个对话的完整生命周期
- **标识**：`sessionId`（UUID）+ `sessionKey`（渠道特定）
- **存储**：
  - `session-store.json`：元数据索引
  - `<sessionId>.jsonl`：完整消息历史
- **生命周期**：创建 → 活跃 → 压缩 → 归档/删除

### Subagent（子代理）

- **定义**：Agent 调用自身（如 session_tool）创建的子会话
- **属性**：
  - `spawnedBy`：父会话 key
  - `spawnDepth`：嵌套深度
  - `subagentRole`：orchestrator 或 leaf
- **生命周期**：prepareSubagentSpawn → 执行 → onSubagentEnded

### 压缩（Compaction）

- **触发条件**：
  1. Token 溢出（自动）
  2. 手动触发（/compact）
  3. 定期维护
- **策略**：
  1. 删除冗长的工具结果
  2. 修剪最旧的会话轮次
  3. 生成摘要替代历史
- **输出**：
  - `summary`：生成的摘要文本
  - `firstKeptEntryId`：保留的最旧消息 ID
  - `tokensBefore/After`：压缩前后的 token 数

### Memory（记忆）

- **存储**：SQLite 数据库
  - `files`：文件元数据
  - `chunks`：文本块 + 嵌入向量
  - `chunks_fts`：全文搜索索引
  - `embedding_cache`：嵌入缓存
- **搜索模式**：
  1. Hybrid：向量 + 关键词
  2. FTS-Only：仅关键词（无嵌入）
  3. Vector-Only：仅向量（FTS 不可用）

---

## 并发控制

### 三层锁机制

```
┌─────────────────────────────────────────┐
│ Layer 1: Session Store Queue         │
│ (session-store.ts)                  │
│ - 每个 storePath 一个队列             │
│ - FIFO 调度                         │
│ - 10 秒超时                         │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Layer 2: Session Write Lock         │
│ (session-write-lock.ts)              │
│ - 文件锁（<sessionFile>.lock）      │
│ - PID 检测 + starttime            │
│ - 看门狗（1 分钟间隔）            │
│ - 最多持有 5 分钟                    │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Layer 3: Lane Queue                │
│ (compact.ts)                       │
│ - Session Lane + Global Lane        │
│ - 避免死锁                         │
└─────────────────────────────────────────┘
```

### 锁获取顺序

```
1. Session Store Queue (store.ts)
   ↓
2. Session Write Lock (session-write-lock.ts)
   ↓
3. Session Lane + Global Lane (compact.ts)
```

---

## 缓存策略

### Session Store Cache

- **存储**：内存 Map（`Map<storePath, CacheEntry>`）
- **TTL**：45 秒（可通过 `OPENCLAW_SESSION_CACHE_TTL_MS` 调整）
- **失效**：
  - TTL 过期
  - 文件 mtime 变化
  - 文件大小变化

### Context Window Cache

- **存储**：全局 Map（`Map<modelId, contextTokens>`）
- **加载时机**：启动时异步加载
- **优先级**：配置覆盖 > 模型内置 > 默认值

### Embedding Cache

- **存储**：SQLite 表（`embedding_cache`）
- **键**：`(text, provider, model)`
- **用途**：避免重复嵌入 API 调用

---

## Hooks 和扩展点

### Internal Hooks

```typescript
// session:compact:before
createInternalHookEvent("session", "compact:before", sessionKey, {
  sessionId,
  messageCount,
  tokenCount,
  messageCountOriginal,
  tokenCountOriginal,
});

// session:compact:after
createInternalHookEvent("session", "compact:after", sessionKey, {
  sessionId,
  messageCount,
  tokenCount,
  compactedCount,
  summaryLength,
  tokensBefore,
  tokensAfter,
  firstKeptEntryId,
});
```

### Plugin Hooks

```typescript
// before_compaction
await hookRunner.runBeforeCompaction(
  { messageCount, tokenCount },
  { sessionId, agentId, sessionKey, ... }
);

// after_compaction
await hookRunner.runAfterCompaction(
  { messageCount, tokenCount, compactedCount },
  { sessionId, agentId, sessionKey, ... }
);
```

### Context Engine Hooks

```typescript
// 可选的 ContextEngine 方法
interface ContextEngine {
  bootstrap?(params): Promise<BootstrapResult>;
  afterTurn?(params): Promise<void>;
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation>;
  onSubagentEnded?(params): Promise<void>;
  dispose?(): Promise<void>;
}
```

---

## 错误恢复

### Session Store 只读恢复

```typescript
private isReadonlyDbError(err: unknown): boolean {
  const readonlyPattern =
    /attempt to write a readonly database|
     database is read-only|
     SQLITE_READONLY/i;
  // ...
}

private async runSyncWithReadonlyRecovery(opts): Promise<void> {
  try {
    await this.runSync(opts);
  } catch (err) {
    if (this.isReadonlyDbError(err)) {
      // 重新打开数据库
      this.db.close();
      this.db = this.openDatabase();
      this.ensureSchema();
      // 重试
      await this.runSync(opts);
    } else {
      throw err;
    }
  }
}
```

### Session 文件修复

```typescript
// 在压缩前自动修复
await repairSessionFileIfNeeded({
  sessionFile: params.sessionFile,
  warn: (message) => log.warn(message),
});

// 工具调用配对修复
const repaired = sanitizeToolUseResultPairing(messages);
```

---

## 配置汇总

### 上下文相关配置

```yaml
# Context Engine
plugins:
  slots:
    contextEngine: "legacy"  # 或自定义引擎 id

# Context Window
agents:
  defaults:
    contextTokens: 200_000        # 上下文窗口上限（可选）
    compaction:
      model: "anthropic/claude-sonnet-4-20250514"  # 压缩专用模型（可选）

# Memory
memory:
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

  store:
    path: ~/.openclaw/memory/index.db
    vector:
      enabled: true

  provider: openai
  model: text-embedding-3-small
  remote: false
  fallback: local

  cache:
    enabled: true
    maxEntries: 10000

  sync:
    onSessionStart: true
    onSearch: false
    intervalMs: 60000

  extraPaths:
    - /path/to/extra/memory

# Session Maintenance
sessionMaintenance:
  mode: "enforce"  # 或 "warn"
  pruneAfterDays: 30
  maxEntries: 100
  rotateBytes: 10485760  # 10 MB
```

---

## 性能优化

### 1. 懒加载

```typescript
// compact.ts 中的动态导入
const { compactEmbeddedPiSessionDirect } =
  await import("../agents/pi-embedded-runner/compact.runtime.js");
```

### 2. 批处理

```typescript
// Memory 中的嵌入批处理
protected batch: {
  enabled: boolean;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
};
```

### 3. 缓存

- Session Store 缓存（45 秒 TTL）
- Context Window 缓存（进程级）
- Embedding 缓存（SQLite）

### 4. 文件监听

```typescript
// Memory 中的文件监听
this.watcher = chokidar.watch(watchPaths, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
});
```

---

## 监控和诊断

### Compaction 诊断

```typescript
// compact.ts 中的详细日志
if (diagEnabled && preMetrics) {
  log.debug(
    `[compaction-diag] start ` +
    `pre.messages=${preMetrics.messages} ` +
    `pre.estTokens=${preMetrics.estTokens ?? "unknown"}`
  );
}

if (diagEnabled && postMetrics) {
  log.debug(
    `[compaction-diag] end outcome=compacted ` +
    `post.messages=${postMetrics.messages} ` +
    `delta.messages=${postMetrics.messages - preMetrics.messages}`
  );
}
```

### Memory 状态

```typescript
const status = await manager.status();

console.log({
  files: status.files,
  chunks: status.chunks,
  provider: status.provider,
  model: status.model,
  searchMode: status.custom?.searchMode,
  fts: status.fts,
  vector: status.vector,
});
```

---

## 目录索引

| 目录 | README |
|------|---------|
| `src/context-engine/` | [context-engine/README.md](../context-engine/README.md) |
| `src/config/sessions/` | [sessions/README.md](../config/sessions/README.md) |
| `src/agents/pi-embedded-runner/`（compact.ts） | [README_COMPACT.md](../agents/pi-embedded-runner/README_COMPACT.md) |
| `src/agents/`（context*.ts） | [README_CONTEXT.md](../agents/README_CONTEXT.md) |
| `src/memory/` | [memory/README.md](../memory/README.md) |

---

## 扩展指南

### 添加自定义上下文引擎

1. 实现 `ContextEngine` 接口（参考 `legacy.ts`）
2. 通过 `registerContextEngine` 注册
3. 配置中指定引擎 id
4. 实现 `bootstrap/afterTurn/compact` 等方法

### 修改压缩策略

1. 继承或修改 `LegacyContextEngine`
2. 或创建新的 ContextEngine 实现
3. 覆盖 `compact` 方法
4. 自定义摘要生成逻辑

### 扩展 Memory

1. 修改 `manager.ts` 中的搜索逻辑
2. 添加新的嵌入提供商（参考 `embeddings.ts`）
3. 自定义 Hybrid 融合策略
4. 添加新的 MMR 或 Temporal Decay 实现

---

## 故障排查

### Session Store 问题

```
问题：session-store.json 损坏
排查：
  1. 检查 `loadSessionStore` 是否抛出
  2. 查看 `applySessionStoreMigrations` 是否正确
  3. 检查写入锁是否正常释放

解决：
  - 恢复备份（如果有）
  - 删除损坏文件，重新初始化
```

### 压缩问题

```
问题：压缩频繁或失败
排查：
  1. 检查 `contextTokens` 配置是否过小
  2. 查看压缩日志（`[compaction-diag]`）
  3. 验证压缩模型 API key 是否有效
  4. 检查 `tokenBefore/tokensAfter` 差异

解决：
  - 调整 `contextTokens` 或 `compaction.model`
  - 增加 `minScore` 阈值
  - 检查嵌入提供商配额
```

### Memory 搜索问题

```
问题：搜索结果不相关或为空
排查：
  1. 检查 `vector.enabled` 和 `fts.enabled`
  2. 验证嵌入模型是否正确加载
  3. 查看搜索日志，确认向量/关键词搜索是否执行
  4. 检查 `minScore` 阈值是否过高
  5. 确认 `memory/` 和 `memory/*.md` 文件存在

解决：
  - 调整 `vectorWeight` 和 `textWeight`
  - 降低 `minScore`
  - 触发手动同步（`memory sync`）
  - 检查嵌入提供商状态
```

---

## 下一步

了解上下文管理架构后，你可以：

1. **自定义上下文引擎**：实现特定的压缩/组装策略
2. **优化压缩策略**：调整摘要生成、历史修剪逻辑
3. **扩展 Memory**：添加新的搜索模式或嵌入提供商
4. **调整配置**：优化上下文窗口、搜索权重、缓存策略
5. **添加 hooks**：监听压缩事件，集成自定义逻辑

需要帮助？请参考各目录的详细 README 文档。
