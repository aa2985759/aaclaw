---
title: "Session Pruning"
summary: "Session pruning：裁剪 tool result 以减少上下文膨胀"
read_when:
  - 你希望减少工具输出导致的 LLM 上下文增长
  - 你正在调优 agents.defaults.contextPruning
---

# Session Pruning

在每次 LLM 调用之前，从内存中的上下文裁剪 **旧的 tool result**。它 **不会** 修改磁盘上的会话历史（`*.jsonl`）。

提供两种模式：

- **`cache-ttl`** — 启发式裁剪：基于字符大小比例裁剪/清除旧的 tool result。
- **`semantic-compression`** — 基于 LLM 的压缩：将旧的交互发送给压缩模型，生成简洁的摘要。

## 何时运行

- 当 `mode: "cache-ttl"` 启用且该会话的上一次 Anthropic 调用距今已超过 `ttl` 时触发。
- 仅影响该次请求发送给模型的消息。
- 仅对 Anthropic API 调用（以及 OpenRouter 上的 Anthropic 模型）生效。
- 为获得最佳效果，将 `ttl` 与模型的 `cacheRetention` 策略匹配（`short` = 5m，`long` = 1h）。
- 裁剪完成后，TTL 窗口重置，后续请求可继续使用缓存直到 `ttl` 再次到期。

## 智能默认值（Anthropic）

- **OAuth 或 setup-token** 配置：启用 `cache-ttl` 裁剪，心跳设为 `1h`。
- **API key** 配置：启用 `cache-ttl` 裁剪，心跳设为 `30m`，Anthropic 模型默认 `cacheRetention: "short"`。
- 如果你显式设置了这些值，OpenClaw **不会** 覆盖它们。

## 这能改善什么（成本 + 缓存行为）

- **为什么要裁剪：** Anthropic 的 prompt 缓存仅在 TTL 内有效。如果会话空闲超过 TTL，下一次请求会重新缓存完整 prompt，除非你先裁剪它。
- **什么变便宜了：** 裁剪减少了 TTL 过期后首次请求的 **cacheWrite** 大小。
- **TTL 重置为什么重要：** 裁剪运行后缓存窗口重置，后续请求可以复用刚缓存的 prompt，而不是再次重新缓存完整历史。
- **它不做什么：** 裁剪不会增加 token 或产生"双倍"成本；它只改变 TTL 过期后首次请求时被缓存的内容。
## 哪些内容可被裁剪

- 仅限 `toolResult` 消息。
- User + assistant 消息 **永远不会** 被修改。
- 最后 `keepLastAssistants` 条 assistant 消息受保护；在此截断点之后的 tool result 不会被裁剪。
- 如果 assistant 消息数量不足以建立截断点，则跳过裁剪。
- 包含 **image blocks** 的 tool result 会被跳过（永远不裁剪/清除）。
## 上下文窗口估算

裁剪使用估算的上下文窗口（字符数 ≈ token 数 × 4）。基础窗口按以下顺序解析：

1. `models.providers.*.models[].contextWindow` 覆盖值。
2. 模型定义中的 `contextWindow`（来自模型注册表）。
3. 默认 `200000` tokens。

如果设置了 `agents.defaults.contextTokens`，则将其作为解析窗口的上限（取较小值）。

## 模式

### cache-ttl

- 仅当上一次 Anthropic 调用距今已超过 `ttl`（默认 `5m`）时才运行裁剪。
- 运行时：执行与之前相同的 soft-trim + hard-clear 行为。

### semantic-compression

当上下文使用量超过可配置的阈值时，使用 LLM 智能压缩旧的交互记录。

**工作原理：**

1. 当上下文大小超过 `triggerRatio` × 上下文窗口时，触发压缩。
2. 旧的交互块（用户消息 + 后续所有 assistant/tool 轮次）被发送给压缩模型。
3. 模型将每个旧交互块替换为简洁的摘要，保留后续轮次可能需要的信息。
4. 压缩 **异步** 运行 — 当前请求使用启发式裁剪器作为兜底；压缩结果被缓存，在下一次请求时应用。

**保护规则：**

- 最近 `keepLastUserTurns` 次用户交互永远不会被压缩。
- 引导阶段消息（第一条用户消息之前的内容）永远不会被压缩。
- 包含错误 tool result 的交互块保持原样（错误通常具有重要的诊断价值）。
- 已压缩的块不会被重复压缩。
- 小于 `minCompressibleChars` 的块会被跳过。

**压缩粒度：**

- `compressByInteractionBlock: true`（默认）— 将每个交互块作为整体压缩。由于模型能理解完整的调用链，因此产出最紧凑的输出。
- `compressByInteractionBlock: false` — 独立压缩每条 tool result。更简单但效果较差。

**Prompt 模板：**

压缩用的 prompt 以文本文件形式存储在 `src/agents/pi-extensions/context-pruning/prompts/` 下：

- `interaction-block-compression.txt` — 交互块级压缩的 prompt。
- `tool-result-compression.txt` — 逐条 tool result 压缩的 prompt。

你可以直接编辑这些文件来调优压缩行为，无需修改 TypeScript 代码。另外也提供了 `customInstructions` 配置字段，用于轻量级的 prompt 追加，无需编辑模板文件。

## 软裁剪 vs 硬裁剪

- **Soft-trim**：仅针对超大的 tool result。
  - 保留头部 + 尾部，中间插入 `...`，并附加原始大小的说明。
  - 跳过包含 image blocks 的结果。
- **Hard-clear**：用 `hardClear.placeholder` 替换整个 tool result。

## 工具选择

- `tools.allow` / `tools.deny` 支持 `*` 通配符。
- deny 优先。
- 匹配不区分大小写。
- allow 列表为空 => 允许所有工具。

## 与其他限制的交互

- 内置工具已经会截断自身输出；session pruning 是一个额外的层级，防止长时间对话在模型上下文中积累过多的工具输出。
- Compaction 是独立的：compaction 会总结并持久化，而 pruning 是每次请求的临时操作。参见 [/concepts/compaction](/concepts/compaction)。

## 默认值（启用时）

### cache-ttl 默认值

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

### semantic-compression 默认值

- `triggerRatio`: `0.5`（当上下文使用量超过窗口的 50% 时触发压缩）
- `keepLastUserTurns`: `3`
- `minCompressibleChars`: `500`
- `compressByInteractionBlock`: `true`
- `customInstructions`: `""`（空）

## 示例

默认（关闭）：

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

启用基于 TTL 的裁剪：

```json5
{
  agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "5m" } } },
}
```

启用语义压缩：

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "semantic-compression",
        semanticCompression: {
          triggerRatio: 0.5,
          keepLastUserTurns: 3,
          minCompressibleChars: 500,
          compressByInteractionBlock: true,
          customInstructions: "",
        },
      },
    },
  },
}
```

限制裁剪到特定工具：

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",
        tools: { allow: ["exec", "read"], deny: ["*image*"] },
      },
    },
  },
}
```

参见配置参考：[Gateway Configuration](/gateway/configuration)
