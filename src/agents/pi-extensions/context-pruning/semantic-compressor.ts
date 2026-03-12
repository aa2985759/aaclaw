import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { generateSummary } from "@mariozechner/pi-coding-agent";
import { retryAsync } from "../../../infra/retry.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { EffectiveSemanticCompressionSettings } from "./settings.js";

const log = createSubsystemLogger("semantic-compressor");

const CHARS_PER_TOKEN_ESTIMATE = 4;

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

const promptCache = new Map<string, string>();

function loadPromptTemplate(fileName: string): string {
  const cached = promptCache.get(fileName);
  if (cached) return cached;

  const filePath = path.join(PROMPTS_DIR, fileName);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    promptCache.set(fileName, content);
    return content;
  } catch (error) {
    log.warn(
      `Failed to load prompt template ${fileName}: ${
        error instanceof Error ? error.message : String(error)
      }. Using inline fallback.`,
    );
    return "";
  }
}

/** Marker prefix to identify already-compressed content. */
export const SEMANTIC_COMPRESSION_MARKER = "[semantically compressed]";

// ---------------------------------------------------------------------------
// Interaction block extraction
// ---------------------------------------------------------------------------

/**
 * An interaction block represents one user-initiated exchange: the user message
 * followed by all assistant + tool turns until the next user message.
 */
export type InteractionBlock = {
  /** Index of the first message in this block (within the full messages array). */
  startIndex: number;
  /** Index one past the last message in this block. */
  endIndex: number;
  /** The messages belonging to this block. */
  messages: AgentMessage[];
};

/**
 * Split an ordered message array into interaction blocks.  Each block starts
 * with a `user` message and contains every subsequent message up to (but not
 * including) the next `user` message.
 *
 * Messages before the first user message (bootstrap phase) are grouped into a
 * special "pre-user" block that is always protected from compression.
 */
export function extractInteractionBlocks(messages: AgentMessage[]): InteractionBlock[] {
  const blocks: InteractionBlock[] = [];
  let blockStart = 0;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user" && i > blockStart) {
      blocks.push({
        startIndex: blockStart,
        endIndex: i,
        messages: messages.slice(blockStart, i),
      });
      blockStart = i;
    }
  }

  // Last block
  if (blockStart < messages.length) {
    blocks.push({
      startIndex: blockStart,
      endIndex: messages.length,
      messages: messages.slice(blockStart),
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asText(text: string): TextContent {
  return { type: "text", text };
}

function estimateBlockChars(block: InteractionBlock): number {
  let chars = 0;
  for (const msg of block.messages) {
    chars += estimateMessageChars(msg);
  }
  return chars;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    let len = 0;
    for (const block of content) {
      if (block.type === "text") {
        len += block.text.length;
      }
    }
    return len;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
      if (b.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    for (const block of message.content) {
      if (block.type === "text") {
        return block.text.length;
      }
    }
    return 0;
  }

  return 256;
}

/** Check if a message has already been semantically compressed. */
function isAlreadyCompressed(msg: AgentMessage): boolean {
  if (msg.role === "toolResult") {
    for (const block of (msg as ToolResultMessage).content) {
      if (block.type === "text" && block.text.startsWith(SEMANTIC_COMPRESSION_MARKER)) {
        return true;
      }
    }
    return false;
  }
  if (msg.role === "assistant") {
    for (const b of msg.content) {
      if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text.startsWith(SEMANTIC_COMPRESSION_MARKER)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/** Check if a block contains any error tool results. */
function blockContainsErrors(block: InteractionBlock): boolean {
  return block.messages.some(
    (m) => m.role === "toolResult" && (m as ToolResultMessage).isError === true,
  );
}

/** Check whether the block is from the bootstrap phase (before first user message). */
function isBootstrapBlock(block: InteractionBlock): boolean {
  return block.messages.length > 0 && block.messages[0]?.role !== "user";
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const INTERACTION_BLOCK_PROMPT_FILE = "interaction-block-compression.txt";

function buildCompressionPrompt(
  blocks: InteractionBlock[],
  customInstructions: string,
): string {
  const sections: string[] = [];

  const template = loadPromptTemplate(INTERACTION_BLOCK_PROMPT_FILE);
  if (template) {
    sections.push(template);
  } else {
    // Minimal inline fallback in case the template file is missing
    sections.push(
      `You are a context compression assistant. Compress each interaction block below into a brief summary.\n` +
      `Keep information that future turns might need. Omit verbose intermediate data.\n` +
      `Output format: ### Block <N>\n<compressed summary>`,
    );
  }

  if (customInstructions) {
    sections.push(`\n## Additional instructions\n${customInstructions}`);
  }

  sections.push("\n---\n\n## Interaction blocks to compress\n");

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    sections.push(`### Block ${i + 1}`);
    for (const msg of block.messages) {
      sections.push(serializeMessageForPrompt(msg));
    }
    sections.push("");
  }

  return sections.join("\n");
}

function serializeMessageForPrompt(msg: AgentMessage): string {
  if (msg.role === "user") {
    const content = typeof msg.content === "string"
      ? msg.content
      : (msg.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
    return `[User]: ${content}`;
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const b of msg.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
      if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "unknown_tool";
        let argsStr: string;
        try {
          argsStr = JSON.stringify(b.arguments ?? {});
          // Truncate very long arguments for the compression prompt
          if (argsStr.length > 500) {
            argsStr = argsStr.slice(0, 500) + "...";
          }
        } catch {
          argsStr = "{}";
        }
        parts.push(`[Tool Call: ${name}(${argsStr})]`);
      }
    }
    return `[Assistant]: ${parts.join("\n")}`;
  }

  if (msg.role === "toolResult") {
    const toolMsg = msg as ToolResultMessage;
    const toolName = toolMsg.toolName ?? "unknown";
    const textParts: string[] = [];
    for (const block of toolMsg.content) {
      if (block.type === "text") {
        // Truncate very long tool results for the compression prompt
        const text = block.text.length > 2000
          ? block.text.slice(0, 1000) + "\n...[truncated]...\n" + block.text.slice(-500)
          : block.text;
        textParts.push(text);
      }
      if (block.type === "image") {
        textParts.push("[image content]");
      }
    }
    const errorTag = toolMsg.isError ? " (ERROR)" : "";
    return `[Tool Result: ${toolName}${errorTag}]: ${textParts.join("\n")}`;
  }

  return `[${msg.role}]: (message)`;
}

// ---------------------------------------------------------------------------
// Parsing LLM response
// ---------------------------------------------------------------------------

function parseCompressionResponse(
  response: string,
  blockCount: number,
): string[] {
  const results: string[] = [];
  // Match "### Block N" sections
  const blockRegex = /###\s*Block\s+(\d+)\s*\n([\s\S]*?)(?=###\s*Block\s+\d+|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(response)) !== null) {
    const content = match[2]?.trim() ?? "";
    results.push(content);
  }

  // If parsing failed, try to split by numbered sections
  if (results.length === 0 && blockCount === 1) {
    results.push(response.trim());
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main compression functions
// ---------------------------------------------------------------------------

export type SemanticCompressionParams = {
  messages: AgentMessage[];
  settings: EffectiveSemanticCompressionSettings;
  ctx: Pick<ExtensionContext, "model">;
  contextWindowTokensOverride?: number;
  /** API key for the LLM call. */
  apiKey: string;
  /** Abort signal. */
  signal: AbortSignal;
  /** Optional predicate to check if a tool is eligible for compression. */
  isToolPrunable?: (toolName: string) => boolean;
};

/**
 * Compress old interaction blocks using an LLM. Returns a new message array
 * where old blocks have been replaced with compressed summaries.
 *
 * When `compressByInteractionBlock` is true (default), each old interaction block
 * (user message → all assistant/tool turns until next user) is compressed as a unit.
 * The user message is preserved verbatim; all assistant + tool messages are replaced
 * by a single compressed assistant message.
 *
 * When `compressByInteractionBlock` is false, individual tool results are compressed
 * independently (simpler but less effective).
 */
export async function semanticCompressMessages(
  params: SemanticCompressionParams,
): Promise<AgentMessage[]> {
  const { messages, settings, ctx, apiKey, signal, isToolPrunable } = params;

  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;

  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  const totalChars = messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
  const ratio = totalChars / charWindow;

  if (ratio < settings.triggerRatio) {
    return messages;
  }

  if (settings.compressByInteractionBlock) {
    return compressByInteractionBlock(params, charWindow);
  }
  return compressByToolResult(params, charWindow);
}

// ---------------------------------------------------------------------------
// Interaction-block-level compression
// ---------------------------------------------------------------------------

async function compressByInteractionBlock(
  params: SemanticCompressionParams,
  charWindow: number,
): Promise<AgentMessage[]> {
  const { messages, settings, apiKey, signal, ctx } = params;
  const blocks = extractInteractionBlocks(messages);

  if (blocks.length === 0) {
    return messages;
  }

  // Determine which blocks are protected (recent N user turns + bootstrap)
  const userBlocks = blocks.filter((b) => b.messages.length > 0 && b.messages[0]?.role === "user");
  const protectedUserBlockCount = Math.min(settings.keepLastUserTurns, userBlocks.length);
  const protectedUserBlocks = new Set(
    userBlocks.slice(userBlocks.length - protectedUserBlockCount),
  );

  // Identify compressible blocks
  const compressibleBlocks: InteractionBlock[] = [];
  for (const block of blocks) {
    // Skip bootstrap blocks
    if (isBootstrapBlock(block)) continue;
    // Skip protected (recent) blocks
    if (protectedUserBlocks.has(block)) continue;
    // Skip already-compressed blocks
    if (block.messages.some(isAlreadyCompressed)) continue;
    // Skip blocks containing error tool results (preserve for diagnostics)
    if (blockContainsErrors(block)) continue;
    // Skip blocks that are too small
    if (estimateBlockChars(block) < settings.minCompressibleChars) continue;

    compressibleBlocks.push(block);
  }

  if (compressibleBlocks.length === 0) {
    return messages;
  }

  // Build the compression prompt and call LLM
  const prompt = buildCompressionPrompt(compressibleBlocks, settings.customInstructions);
  const model = ctx.model;
  if (!model) {
    log.warn("Semantic compression: no model available; skipping.");
    return messages;
  }

  let response: string;
  try {
    // Use the model's generateSummary which takes messages + model + reserveTokens + apiKey + signal
    const promptMessages: AgentMessage[] = [
      { role: "user", content: prompt, timestamp: Date.now() },
    ];
    const reserveTokens = Math.max(1, Math.floor(charWindow / CHARS_PER_TOKEN_ESTIMATE * 0.1));
    response = await retryAsync(
      () => generateSummary(promptMessages, model, reserveTokens, apiKey, signal),
      {
        attempts: 2,
        minDelayMs: 500,
        maxDelayMs: 3000,
        jitter: 0.2,
        label: "semantic-compression/generateSummary",
        shouldRetry: (err) => !(err instanceof Error && err.name === "AbortError"),
      },
    );
  } catch (error) {
    log.warn(
      `Semantic compression failed; keeping original messages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return messages;
  }

  // Parse the response
  const compressed = parseCompressionResponse(response, compressibleBlocks.length);

  if (compressed.length === 0) {
    log.warn("Semantic compression: failed to parse LLM response; keeping original messages.");
    return messages;
  }

  // Build the new message array, replacing compressed blocks
  const next = messages.slice();
  // Process blocks in reverse order so index shifts don't affect earlier blocks
  for (let i = Math.min(compressed.length, compressibleBlocks.length) - 1; i >= 0; i--) {
    const block = compressibleBlocks[i];
    const summary = compressed[i];
    if (!summary || !block) continue;

    // Keep the user message, replace everything else with a compressed assistant message
    const userMsg = block.messages.find((m) => m.role === "user");
    const compressedAssistantMsg: AgentMessage = {
      role: "assistant",
      content: [asText(`${SEMANTIC_COMPRESSION_MARKER} ${summary}`)],
      api: "openai-responses" as const,
      provider: "openai",
      model: "semantic-compression",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage;

    const replacement: AgentMessage[] = userMsg
      ? [userMsg, compressedAssistantMsg]
      : [compressedAssistantMsg];

    next.splice(block.startIndex, block.endIndex - block.startIndex, ...replacement);

    // Adjust indices for subsequent blocks (they shift because we changed array length)
    const delta = replacement.length - (block.endIndex - block.startIndex);
    for (let j = 0; j < i; j++) {
      if (compressibleBlocks[j].startIndex > block.startIndex) {
        compressibleBlocks[j] = {
          ...compressibleBlocks[j],
          startIndex: compressibleBlocks[j].startIndex + delta,
          endIndex: compressibleBlocks[j].endIndex + delta,
        };
      }
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// Per-tool-result compression (simpler fallback)
// ---------------------------------------------------------------------------

async function compressByToolResult(
  params: SemanticCompressionParams,
  charWindow: number,
): Promise<AgentMessage[]> {
  const { messages, settings, ctx, apiKey, signal, isToolPrunable } = params;

  // Find the user turn protection cutoff
  let protectedStartIndex = messages.length;
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= settings.keepLastUserTurns) {
        protectedStartIndex = i;
        break;
      }
    }
  }

  // Find first user message (bootstrap protection)
  let firstUserIndex = messages.length;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      firstUserIndex = i;
      break;
    }
  }

  // Collect compressible tool results
  const compressibleIndices: number[] = [];
  const toolResultTexts: string[] = [];

  for (let i = firstUserIndex; i < protectedStartIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") continue;
    if (isAlreadyCompressed(msg)) continue;

    const toolMsg = msg as ToolResultMessage;
    if (isToolPrunable && !isToolPrunable(toolMsg.toolName)) continue;

    const chars = estimateMessageChars(msg);
    if (chars < settings.minCompressibleChars) continue;

    compressibleIndices.push(i);
    toolResultTexts.push(serializeMessageForPrompt(msg));
  }

  if (compressibleIndices.length === 0) {
    return messages;
  }

  // Build per-tool-result compression prompt
  const TOOL_RESULT_PROMPT_FILE = "tool-result-compression.txt";
  const toolResultTemplate = loadPromptTemplate(TOOL_RESULT_PROMPT_FILE);
  const promptParts = [
    toolResultTemplate || (
      `You are a context compression assistant. Compress each tool result below into a brief summary.\n` +
      `Keep any information that future conversation turns might need to reference.\n` +
      `Omit verbose raw data that the conclusion already covers.`
    ),
    ``,
    settings.customInstructions ? `## Additional instructions\n${settings.customInstructions}\n` : "",
    `## Tool results to compress`,
    ``,
  ];

  for (let i = 0; i < toolResultTexts.length; i++) {
    promptParts.push(`### Result ${i + 1}`);
    promptParts.push(toolResultTexts[i]);
    promptParts.push("");
  }

  // Output format reminder is already in the template; add a closing note only if using fallback
  if (!toolResultTemplate) {
    promptParts.push(`For each result output:\n\`\`\`\n### Result <N>\n<compressed summary>\n\`\`\``);
  }

  const model = ctx.model;
  if (!model) {
    log.warn("Semantic compression: no model available; skipping.");
    return messages;
  }

  let response: string;
  try {
    const promptMessages: AgentMessage[] = [
      { role: "user", content: promptParts.join("\n"), timestamp: Date.now() },
    ];
    const reserveTokens = Math.max(1, Math.floor(charWindow / CHARS_PER_TOKEN_ESTIMATE * 0.1));
    response = await retryAsync(
      () => generateSummary(promptMessages, model, reserveTokens, apiKey, signal),
      {
        attempts: 2,
        minDelayMs: 500,
        maxDelayMs: 3000,
        jitter: 0.2,
        label: "semantic-compression/tool-result",
        shouldRetry: (err) => !(err instanceof Error && err.name === "AbortError"),
      },
    );
  } catch (error) {
    log.warn(
      `Semantic compression (per-tool-result) failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return messages;
  }

  // Parse response
  const resultRegex = /###\s*Result\s+(\d+)\s*\n([\s\S]*?)(?=###\s*Result\s+\d+|$)/gi;
  const compressedResults = new Map<number, string>();
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(response)) !== null) {
    const idx = parseInt(match[1], 10) - 1;
    const content = match[2]?.trim() ?? "";
    if (content) {
      compressedResults.set(idx, content);
    }
  }

  if (compressedResults.size === 0) {
    log.warn("Semantic compression: failed to parse per-tool-result response; keeping originals.");
    return messages;
  }

  // Replace tool results
  const next = messages.slice();
  for (let i = 0; i < compressibleIndices.length; i++) {
    const summary = compressedResults.get(i);
    if (!summary) continue;

    const msgIndex = compressibleIndices[i];
    const original = messages[msgIndex] as ToolResultMessage;

    next[msgIndex] = {
      ...original,
      content: [asText(`${SEMANTIC_COMPRESSION_MARKER} ${summary}`)],
    } as unknown as AgentMessage;
  }

  return next;
}
