/**
 * Opt-in context pruning ("microcompact"-style) for Pi sessions.
 *
 * This only affects the in-memory context for the current request; it does not rewrite session
 * history persisted on disk.
 *
 * Supports two modes:
 * - "cache-ttl": Legacy heuristic pruning (soft trim + hard clear based on character ratios).
 * - "semantic-compression": LLM-based semantic compression of old interaction blocks (async).
 */

export { default } from "./context-pruning/extension.js";

export { pruneContextMessages } from "./context-pruning/pruner.js";
export type {
  ContextPruningConfig,
  ContextPruningToolMatch,
  EffectiveContextPruningSettings,
  SemanticCompressionConfig,
  EffectiveSemanticCompressionSettings,
} from "./context-pruning/settings.js";
export {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  DEFAULT_SEMANTIC_COMPRESSION_SETTINGS,
} from "./context-pruning/settings.js";

export {
  semanticCompressMessages,
  extractInteractionBlocks,
  SEMANTIC_COMPRESSION_MARKER,
} from "./context-pruning/semantic-compressor.js";
export type {
  InteractionBlock,
  SemanticCompressionParams,
} from "./context-pruning/semantic-compressor.js";
