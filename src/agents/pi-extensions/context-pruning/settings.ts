import { parseDurationMs } from "../../../cli/parse-duration.js";

export type ContextPruningToolMatch = {
  allow?: string[];
  deny?: string[];
};
export type ContextPruningMode = "off" | "cache-ttl" | "semantic-compression";

export type SemanticCompressionConfig = {
  /** Context ratio threshold to trigger semantic compression (default: 0.5). */
  triggerRatio?: number;
  /** Number of recent user turns to protect from compression (default: 3). */
  keepLastUserTurns?: number;
  /** Minimum character length of a tool result to be eligible for compression (default: 500). */
  minCompressibleChars?: number;
  /** Whether to compress per-interaction-block (true) or per-tool-result (false). Default: true. */
  compressByInteractionBlock?: boolean;
  /** Custom instructions appended to the compression prompt. */
  customInstructions?: string;
};

export type EffectiveSemanticCompressionSettings = {
  triggerRatio: number;
  keepLastUserTurns: number;
  minCompressibleChars: number;
  compressByInteractionBlock: boolean;
  customInstructions: string;
};

export type ContextPruningConfig = {
  mode?: ContextPruningMode;
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: ContextPruningToolMatch;
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
  /** Semantic compression settings (only used when mode is "semantic-compression"). */
  semanticCompression?: SemanticCompressionConfig;
};

export type EffectiveContextPruningSettings = {
  mode: Exclude<ContextPruningMode, "off">;
  ttlMs: number;
  keepLastAssistants: number;
  softTrimRatio: number;
  hardClearRatio: number;
  minPrunableToolChars: number;
  tools: ContextPruningToolMatch;
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
  semanticCompression: EffectiveSemanticCompressionSettings;
};

export const DEFAULT_SEMANTIC_COMPRESSION_SETTINGS: EffectiveSemanticCompressionSettings = {
  triggerRatio: 0.5,
  keepLastUserTurns: 3,
  minCompressibleChars: 500,
  compressByInteractionBlock: true,
  customInstructions: "",
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  mode: "cache-ttl",
  ttlMs: 5 * 60 * 1000,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  tools: {},
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
  semanticCompression: { ...DEFAULT_SEMANTIC_COMPRESSION_SETTINGS },
};

export function computeEffectiveSettings(raw: unknown): EffectiveContextPruningSettings | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cfg = raw as ContextPruningConfig;
  if (cfg.mode !== "cache-ttl" && cfg.mode !== "semantic-compression") {
    return null;
  }

  const s: EffectiveContextPruningSettings = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  s.mode = cfg.mode;

  if (typeof cfg.ttl === "string") {
    try {
      s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
    } catch {
      // keep default ttl
    }
  }

  if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) {
    s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
  }
  if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) {
    s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
  }
  if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) {
    s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
  }
  if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) {
    s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
  }
  if (cfg.tools) {
    s.tools = cfg.tools;
  }
  if (cfg.softTrim) {
    if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) {
      s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
    }
    if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) {
      s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
    }
    if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) {
      s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
    }
  }
  if (cfg.hardClear) {
    if (typeof cfg.hardClear.enabled === "boolean") {
      s.hardClear.enabled = cfg.hardClear.enabled;
    }
    if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) {
      s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
    }
  }

  // Parse semantic compression settings
  if (cfg.semanticCompression) {
    const sc = cfg.semanticCompression;
    if (typeof sc.triggerRatio === "number" && Number.isFinite(sc.triggerRatio)) {
      s.semanticCompression.triggerRatio = Math.min(1, Math.max(0, sc.triggerRatio));
    }
    if (typeof sc.keepLastUserTurns === "number" && Number.isFinite(sc.keepLastUserTurns)) {
      s.semanticCompression.keepLastUserTurns = Math.max(0, Math.floor(sc.keepLastUserTurns));
    }
    if (typeof sc.minCompressibleChars === "number" && Number.isFinite(sc.minCompressibleChars)) {
      s.semanticCompression.minCompressibleChars = Math.max(0, Math.floor(sc.minCompressibleChars));
    }
    if (typeof sc.compressByInteractionBlock === "boolean") {
      s.semanticCompression.compressByInteractionBlock = sc.compressByInteractionBlock;
    }
    if (typeof sc.customInstructions === "string") {
      s.semanticCompression.customInstructions = sc.customInstructions.trim();
    }
  }

  return s;
}
