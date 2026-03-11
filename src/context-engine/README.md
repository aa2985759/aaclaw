# Context Engine

上下文引擎（Context Engine）是 OpenClaw 的核心抽象层，负责管理 AI 对话的上下文生命周期。

## 目录职责

`src/context-engine/` 定义了可插拔的上下文管理接口和实现，用于：
- 摄入消息到上下文存储
- 组装模型上下文（消息 + token 预估）
- 压缩上下文以减少 token 使用
- 支持 subagent 生命周期管理
- 通过注册表支持多种引擎实现

---

## 核心设计

### 为什么需要 ContextEngine？

1. **可扩展性**：不同的上下文管理策略可以通过统一的接口实现
2. **向后兼容**：Legacy 引擎保持原有行为不变
3. **插件化**：通过配置切换不同的上下文引擎
4. **关注点分离**：上下文管理与业务逻辑解耦

### 设计模式

- **策略模式**：不同引擎实现不同的压缩/组装策略
- **注册表模式**：全局注册表支持跨 chunk 共享
- **工厂模式**：通过工厂函数创建引擎实例

---

## 文件说明

### `types.ts`

定义 `ContextEngine` 接口和所有相关类型。

#### 核心：ContextEngine 接口

```typescript
interface ContextEngine {
  readonly info: ContextEngineInfo;  // 引擎元数据

  // 必需方法
  ingest(params): Promise<IngestResult>;  // 摄入消息
  assemble(params): Promise<AssembleResult>;  // 组装上下文
  compact(params): Promise<CompactResult>;  // 压缩上下文

  // 可选方法
  bootstrap?(params): Promise<BootstrapResult>;  // 初始化引擎
  ingestBatch?(params): Promise<IngestBatchResult>;  // 批量摄入
  afterTurn?(params): Promise<void>;  // 轮次后处理
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation>;  // 子代理准备
  onSubagentEnded?(params): Promise<void>;  // 子代理结束通知
  dispose?(): Promise<void>;  // 资源清理
}
```

#### 核心类型

| 类型 | 用途 |
|------|------|
| `AssembleResult` | 返回组装后的消息列表 + token 预估 |
| `CompactResult` | 返回压缩结果（摘要、token 变化） |
| `IngestResult` | 返回消息是否被摄入 |
| `BootstrapResult` | 返回初始化结果 |
| `ContextEngineInfo` | 引擎元信息（id、name、version） |

---

### `registry.ts`

上下文引擎注册表，使用 `Symbol.for` 实现跨 chunk 共享。

#### 为什么用 Symbol.for？

```typescript
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
```

- **跨 chunk 共享**：即使代码被打包成多个 chunk，仍共享同一个注册表
- **全局单例**：进程级别唯一的注册表
- **避免重复注册**：确保同一个引擎 id 只注册一次

#### 核心函数

| 函数 | 用途 |
|------|------|
| `registerContextEngine(id, factory)` | 注册引擎工厂 |
| `getContextEngineFactory(id)` | 获取引擎工厂 |
| `listContextEngineIds()` | 列出所有已注册引擎 |
| `resolveContextEngine(config?)` | 根据配置解析使用哪个引擎 |

#### 解析顺序

```typescript
// 1. 配置优先
const slotValue = config?.plugins?.slots?.contextEngine;
// 2. 默认值 fallback
const engineId = slotValue?.trim() || defaultSlotIdForKey("contextEngine");
// 3. 获取工厂并创建实例
return factory();
```

---

### `legacy.ts`

`LegacyContextEngine` 是默认的上下文引擎实现，保持向后兼容。

#### 为什么需要 Legacy 引擎？

1. **向后兼容**：完全兼容原有的压缩行为
2. **最小改动**：ingest/assemble 无操作，compact 委托给现有逻辑
3. **渐进迁移**：新引擎可以逐步替代，不影响现有功能

#### 实现细节

```typescript
class LegacyContextEngine implements ContextEngine {
  async ingest(_params): Promise<IngestResult> {
    // No-op: SessionManager 处理消息持久化
    return { ingested: false };
  }

  async assemble(params): Promise<AssembleResult> {
    // Pass-through: 现有的 sanitize → validate → limit 流程处理组装
    return { messages: params.messages, estimatedTokens: 0 };
  }

  async compact(params): Promise<CompactResult> {
    // 动态导入 compactEmbeddedPiSessionDirect 以保持懒加载
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.runtime.js");
    return compactEmbeddedPiSessionDirect({ ...params.runtimeContext, ...params });
  }
}
```

#### 为什么动态导入？

```typescript
// 保持懒加载边界的有效性
await import("../agents/pi-embedded-runner/compact.runtime.js");
```

- 避免混合静态和动态导入
- 减少 bundle 体积
- 保持懒加载优势

---

## 上下文管理流程

### 1. Bootstrap（初始化）

```
sessionFile 创建
    ↓
ContextEngine.bootstrap({ sessionId, sessionFile })
    ↓
导入历史消息（如果引擎支持）
```

### 2. Ingest（消息摄入）

```
用户消息/工具调用结果
    ↓
ContextEngine.ingest({ sessionId, message, isHeartbeat? })
    ↓
引擎内部存储（如果引擎支持）
```

**Legacy 引擎**：no-op，由 `SessionManager` 直接持久化

### 3. Assemble（上下文组装）

```
准备 AI 调用
    ↓
ContextEngine.assemble({ sessionId, messages, tokenBudget? })
    ↓
返回 AssembleResult {
  messages: AgentMessage[],
  estimatedTokens: number,
  systemPromptAddition?: string  // 可选的系统提示词补充
}
```

**Legacy 引擎**：pass-through，由 `attempt.ts` 的 sanitize → validate → limit 流程处理

### 4. Compact（上下文压缩）

```
Token 溢出或手动触发
    ↓
ContextEngine.compact({ sessionId, sessionFile, tokenBudget?, force? })
    ↓
生成摘要 → 修剪历史 → 减少 token 使用
    ↓
返回 CompactResult {
  ok: boolean,
  compacted: boolean,
  reason?: string,
  result?: {
    summary?: string,  // 生成的摘要
    firstKeptEntryId?: string,
    tokensBefore: number,
    tokensAfter?: number,
    details?: unknown
  }
}
```

**Legacy 引擎**：委托给 `compactEmbeddedPiSessionDirect`

### 5. AfterTurn（轮次后处理）

```
AI 调用完成
    ↓
ContextEngine.afterTurn({ sessionId, sessionFile, messages, ... })
    ↓
持久化上下文 → 触发后台压缩决策
```

**Legacy 引擎**：no-op，由 `SessionManager` 直接持久化

---

## 子代理生命周期支持

### prepareSubagentSpawn

在子代理启动前准备状态：

```typescript
prepareSubagentSpawn?({
  parentSessionKey: string,
  childSessionKey: string,
  ttlMs?: number
}): Promise<SubagentSpawnPreparation | undefined>
```

返回 `rollback` 函数，在子代理启动失败时回滚。

### onSubagentEnded

子代理生命周期结束时通知：

```typescript
onSubagentEnded?({
  childSessionKey: string,
  reason: "deleted" | "completed" | "swept" | "released"
}): Promise<void>
```

---

## 配置和注册

### 注册新引擎

```typescript
import { registerContextEngine } from "./registry.js";

class MyCustomEngine implements ContextEngine {
  readonly info = {
    id: "my-engine",
    name: "My Custom Engine",
    version: "1.0.0"
  };

  // 实现 ingest/assemble/compact...
}

registerContextEngine("my-engine", () => new MyCustomEngine());
```

### 配置切换引擎

```yaml
# config.yaml
plugins:
  slots:
    contextEngine: "my-engine"  # 或 "legacy"
```

---

## 调用入口

```typescript
import { resolveContextEngine } from "./context-engine/index.js";

const engine = await resolveContextEngine(config);

// Ingest
await engine.ingest({ sessionId, message, isHeartbeat });

// Assemble
const { messages, estimatedTokens } = await engine.assemble({
  sessionId,
  messages,
  tokenBudget: 200_000
});

// Compact
const { compacted, result } = await engine.compact({
  sessionId,
  sessionFile,
  tokenBudget,
  force: true
});
```

---

## 扩展点

### 自定义上下文引擎

1. 实现 `ContextEngine` 接口
2. 通过 `registerContextEngine` 注册
3. 配置文件指定引擎 id

### 钩子支持

- `bootstrap`：初始化时加载历史上下文
- `afterTurn`：持久化、触发后台压缩
- `prepareSubagentSpawn`/`onSubagentEnded`：子代理生命周期管理

---

## 关键概念

### ownsCompaction

```typescript
readonly info: ContextEngineInfo & {
  ownsCompaction?: boolean;  // 引擎是否管理自己的压缩生命周期
};
```

- `true`：引擎完全管理压缩，`pi-embedded-runner` 不自动压缩
- `false`/undefined：由 `pi-embedded-runner` 根据触发条件自动压缩

### runtimeContext

```typescript
compact(params: {
  ...
  runtimeContext?: ContextEngineRuntimeContext;  // 运行时提供的额外上下文
}): Promise<CompactResult>
```

传递额外状态给引擎，例如：
- `workspaceDir`：工作目录
- `config`：完整配置
- 其他运行时元数据

---

## 测试

```typescript
// src/context-engine/context-engine.test.ts
```

包含完整的测试套件，覆盖所有接口方法。

---

## 相关目录

- `src/agents/pi-embedded-runner/compact.ts`：Legacy 引擎的压缩实现
- `src/config/sessions/`：Session 存储和管理
- `src/agents/context.ts`：上下文窗口管理
- `src/agents/context-window-guard.ts`：上下文窗口守卫
