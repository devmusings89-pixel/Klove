// Single forced-tool-use LLM call, provider-agnostic. Returns the tool's validated arguments (or
// null when no LLM is configured, so callers can fall back to deterministic/mock behavior).
//
// Providers:
//   - Anthropic (ANTHROPIC_API_KEY) — native Messages API + tool_choice.
//   - OpenAI-compatible (WEB_AGENT_PROVIDER=openai-compatible, e.g. OpenRouter) — chat/completions
//     with a forced function tool. Content blocks (text + images) are translated to OpenAI shape.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema for the tool's arguments
}

export type LlmContent = string | Anthropic.ContentBlockParam[];

// OpenRouter's built-in PDF text extractor (free engine; good for digital/text PDFs). Sent on every
// OpenAI-compatible request — ignored when no file part is present.
const PDF_PLUGIN = [{ id: "file-parser", pdf: { engine: "pdf-text" } }];

/** Does the content carry a PDF/document block? (so we attach the file-parser plugin). */
function hasDocument(content: LlmContent): boolean {
  return Array.isArray(content) && content.some((b) => b.type === "document");
}

/** True when some LLM (Anthropic or an OpenAI-compatible endpoint like OpenRouter) is configured. */
export function llmAvailable(): boolean {
  return (
    Boolean(config.anthropicApiKey) ||
    (config.webAgent.provider === "openai-compatible" && Boolean(config.webAgent.apiKey))
  );
}

/** Run one forced tool call and return its parsed arguments, or null if no LLM is configured. */
export async function runTool<T = Record<string, unknown>>(opts: {
  system: string;
  content: LlmContent;
  tool: ToolSpec;
  maxTokens?: number;
}): Promise<T | null> {
  if (config.anthropicApiKey) return anthropicRunTool<T>(opts);
  if (config.webAgent.provider === "openai-compatible" && config.webAgent.apiKey) return openAiRunTool<T>(opts);
  return null;
}

/** Plain text completion (no tools), or null if no LLM is configured. */
export async function runText(opts: { system: string; content: LlmContent; maxTokens?: number }): Promise<string | null> {
  if (config.anthropicApiKey) {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const resp = await client.messages.create({
      model: config.webAgent.model || "claude-opus-4-8",
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content: typeof opts.content === "string" ? opts.content : opts.content }],
    });
    return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
  if (config.webAgent.provider === "openai-compatible" && config.webAgent.apiKey) {
    const res = await fetch(`${config.webAgent.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.webAgent.apiKey}` },
      body: JSON.stringify({
        model: config.webAgent.model || "anthropic/claude-opus-4.8",
        max_tokens: opts.maxTokens ?? 1024,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: toOpenAiContent(opts.content) },
        ],
        ...(hasDocument(opts.content) ? { plugins: PDF_PLUGIN } : {}),
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }
  return null;
}

// ---- Anthropic ----

async function anthropicRunTool<T>(opts: { system: string; content: LlmContent; tool: ToolSpec; maxTokens?: number }): Promise<T | null> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const resp = await client.messages.create({
    model: config.webAgent.model || "claude-opus-4-8",
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.input_schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: typeof opts.content === "string" ? opts.content : opts.content }],
  });
  for (const block of resp.content) {
    if (block.type === "tool_use" && block.name === opts.tool.name) return block.input as T;
  }
  return null;
}

// ---- OpenAI-compatible (OpenRouter / Ollama) ----

async function openAiRunTool<T>(opts: { system: string; content: LlmContent; tool: ToolSpec; maxTokens?: number }): Promise<T | null> {
  const model = config.webAgent.model || "anthropic/claude-opus-4.8";
  const res = await fetch(`${config.webAgent.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.webAgent.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: toOpenAiContent(opts.content) },
      ],
      tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.input_schema } }],
      tool_choice: { type: "function", function: { name: opts.tool.name } },
      ...(hasDocument(opts.content) ? { plugins: PDF_PLUGIN } : {}),
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { tool_calls?: { function: { name: string; arguments: string } }[]; content?: string } }[];
  };
  const choice = json.choices?.[0];
  const call = choice?.message?.tool_calls?.[0];
  if (!call) return null;
  try {
    return JSON.parse(call.function.arguments) as T;
  } catch (err) {
    // Most common cause: the tool JSON was truncated because max_tokens was hit.
    console.error(
      `runTool(${opts.tool.name}) could not parse tool arguments` +
        (choice?.finish_reason === "length" ? " — output was truncated (raise maxTokens)" : "") +
        `: ${(err as Error).message}`,
    );
    return null;
  }
}

/** Translate a string or Anthropic content blocks into OpenAI chat content. */
function toOpenAiContent(content: LlmContent): unknown {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.source.type === "base64") {
      parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
    } else if (block.type === "document" && (block.source as { type?: string }).type === "base64") {
      // PDFs: OpenRouter parses these via its file-parser plugin (see PDF_PLUGIN on the request).
      const src = block.source as { media_type?: string; data: string };
      parts.push({ type: "file", file: { filename: "document.pdf", file_data: `data:${src.media_type ?? "application/pdf"};base64,${src.data}` } });
    }
  }
  return parts;
}
