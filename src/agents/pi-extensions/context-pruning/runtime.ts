import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { EffectiveContextPruningSettings } from "./settings.js";

export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
  /** API key for semantic compression LLM calls. */
  apiKey?: string | null;
  /** AbortController for in-flight semantic compression. */
  compressionAbortController?: AbortController | null;
  /** Cached result of last async semantic compression (used by next context event). */
  _lastCompressedMessages?: AgentMessage[] | null;
};

// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

export const setContextPruningRuntime = registry.set;

export const getContextPruningRuntime = registry.get;
