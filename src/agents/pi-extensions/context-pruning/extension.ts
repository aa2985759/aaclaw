import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";
import { semanticCompressMessages } from "./semantic-compressor.js";

const log = createSubsystemLogger("context-pruning-ext");

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    // Semantic compression mode: use cached compression results if available,
    // otherwise trigger async compression and fall back to legacy pruner.
    if (runtime.settings.mode === "semantic-compression") {
      // If a previous async compression produced results, use them
      if (runtime._lastCompressedMessages && runtime._lastCompressedMessages.length > 0) {
        const cached = runtime._lastCompressedMessages;
        runtime._lastCompressedMessages = null;
        log.info(
          `Using cached semantic compression: ${event.messages.length} → ${cached.length} messages`,
        );

        // Still trigger async compression on the cached result for continuous refinement
        triggerAsyncSemanticCompression({ ...event, messages: cached }, ctx, runtime);
        return { messages: cached };
      }

      // Fire-and-forget async compression for future requests
      triggerAsyncSemanticCompression(event, ctx, runtime);

      // For the current request, apply the legacy pruner as a synchronous fallback
      // to keep the context within bounds while compression is pending.
      const next = pruneContextMessages({
        messages: event.messages,
        settings: runtime.settings,
        ctx,
        isToolPrunable: runtime.isToolPrunable,
        contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
      });

      if (next === event.messages) {
        return undefined;
      }
      return { messages: next };
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}

/**
 * Triggers asynchronous semantic compression. The compressed result will be
 * available for the *next* request (not the current one). This avoids blocking
 * the current user interaction.
 */
function triggerAsyncSemanticCompression(
  event: ContextEvent,
  ctx: ExtensionContext,
  runtime: NonNullable<ReturnType<typeof getContextPruningRuntime>>,
): void {
  const apiKey = runtime.apiKey;
  if (!apiKey) {
    log.warn("Semantic compression: no API key configured; skipping async compression.");
    return;
  }

  // Abort any in-flight compression
  if (runtime.compressionAbortController) {
    runtime.compressionAbortController.abort();
  }
  const abortController = new AbortController();
  runtime.compressionAbortController = abortController;

  // Run compression asynchronously
  semanticCompressMessages({
    messages: event.messages,
    settings: runtime.settings.semanticCompression,
    ctx,
    apiKey,
    signal: abortController.signal,
    isToolPrunable: runtime.isToolPrunable,
    contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
  })
    .then((compressedMessages) => {
      if (abortController.signal.aborted) return;

      if (compressedMessages !== event.messages) {
        log.info(
          `Semantic compression completed: ${event.messages.length} → ${compressedMessages.length} messages`,
        );
        // Store the compressed messages for the next context event.
        // The compressed messages will be picked up by the session manager on next load.
        runtime._lastCompressedMessages = compressedMessages;
      }
    })
    .catch((error) => {
      if (abortController.signal.aborted) return;
      log.warn(
        `Async semantic compression failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      if (runtime.compressionAbortController === abortController) {
        runtime.compressionAbortController = null;
      }
    });
}
