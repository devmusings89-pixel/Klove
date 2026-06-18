// Single forced-tool-use LLM call, provider-agnostic. Returns the tool's validated arguments (or
// null when no LLM is configured, so callers can fall back to deterministic/mock behavior).
//
// Provider resolution (resolveLlm), highest priority first:
//   - OpenRouter (OPENROUTER_API_KEY) — OpenAI-compatible chat/completions against an Anthropic
//     model. The default path for all analysis use cases.
//   - Anthropic native (ANTHROPIC_API_KEY) — Messages API + tool_choice.
//   - OpenAI-compatible (WEB_AGENT_PROVIDER=openai-compatible, e.g. local Ollama) — fallback.

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

interface LlmEndpoint {
  mode: "anthropic" | "openai";
  apiKey: string;
  baseUrl: string; // OpenAI-compatible only
  model: string;
}

/**
 * Resolve which LLM endpoint serves analysis calls, or null when none is configured.
 * OpenRouter wins when its key is set, so "use OpenRouter for all Anthropic analysis" is just
 * OPENROUTER_API_KEY — it overrides a stray ANTHROPIC_API_KEY too.
 */
function resolveLlm(): LlmEndpoint | null {
  if (config.openRouter.apiKey) {
    return { mode: "openai", apiKey: config.openRouter.apiKey, baseUrl: config.openRouter.baseUrl, model: config.openRouter.model };
  }
  if (config.anthropicApiKey) {
    return { mode: "anthropic", apiKey: config.anthropicApiKey, baseUrl: "", model: config.webAgent.model || "claude-opus-4-8" };
  }
  if (config.webAgent.provider === "openai-compatible" && config.webAgent.apiKey) {
    return { mode: "openai", apiKey: config.webAgent.apiKey, baseUrl: config.webAgent.baseUrl, model: config.webAgent.model || "anthropic/claude-opus-4.8" };
  }
  return null;
}

/** True when some analysis LLM (OpenRouter, Anthropic, or an OpenAI-compatible endpoint) is configured. */
export function llmAvailable(): boolean {
  return resolveLlm() !== null;
}

/** Headers for an OpenAI-compatible request. The OpenRouter attribution headers are harmless elsewhere. */
function openAiHeaders(ep: LlmEndpoint): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ep.apiKey}`,
    "HTTP-Referer": "https://klove.app",
    "X-Title": "Klove",
  };
}

/** Run one forced tool call and return its parsed arguments, or null if no LLM is configured. */
export async function runTool<T = Record<string, unknown>>(opts: {
  system: string;
  content: LlmContent;
  tool: ToolSpec;
  maxTokens?: number;
}): Promise<T | null> {
  const ep = resolveLlm();
  if (!ep) return null;
  return ep.mode === "anthropic" ? anthropicRunTool<T>(ep, opts) : openAiRunTool<T>(ep, opts);
}

/** Plain text completion (no tools), or null if no LLM is configured. */
export async function runText(opts: { system: string; content: LlmContent; maxTokens?: number }): Promise<string | null> {
  const ep = resolveLlm();
  if (!ep) return null;
  if (ep.mode === "anthropic") {
    const client = new Anthropic({ apiKey: ep.apiKey });
    const resp = await client.messages.create({
      model: ep.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
    });
    return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(ep),
    body: JSON.stringify({
      model: ep.model,
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

// ---- Multi-tool agent turn (provider-agnostic) ----
//
// One model turn with MULTIPLE tools available and tool_choice="auto" (the model may answer in text
// OR pick a tool). Returns the assistant text plus any tool calls it made. The agent service drives
// the loop on top of this: execute read-only tools and ask again, or short-circuit state-changing
// tools into the confirm-before-execute gate. Returns null when no LLM is configured.

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTurn {
  text: string;
  toolCalls: AgentToolCall[];
  stopReason: string;
}

export type AgentMessage = { role: "user" | "assistant"; content: string };

export async function runAgent(opts: {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}): Promise<AgentTurn | null> {
  const ep = resolveLlm();
  if (!ep) return null;
  return ep.mode === "anthropic" ? anthropicRunAgent(ep, opts) : openAiRunAgent(ep, opts);
}

async function anthropicRunAgent(ep: LlmEndpoint, opts: { system: string; messages: AgentMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<AgentTurn> {
  const client = new Anthropic({ apiKey: ep.apiKey });
  const resp = await client.messages.create({
    model: ep.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const toolCalls: AgentToolCall[] = [];
  for (const b of resp.content) {
    if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
  }
  return { text, toolCalls, stopReason: resp.stop_reason ?? "" };
}

async function openAiRunAgent(ep: LlmEndpoint, opts: { system: string; messages: AgentMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<AgentTurn> {
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(ep),
    body: JSON.stringify({
      model: ep.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: "system", content: opts.system }, ...opts.messages.map((m) => ({ role: m.role, content: m.content }))],
      tools: opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] } }[];
  };
  const msg = json.choices?.[0]?.message;
  const toolCalls: AgentToolCall[] = [];
  for (const call of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    toolCalls.push({ id: call.id ?? call.function.name, name: call.function.name, input });
  }
  return { text: (msg?.content ?? "").trim(), toolCalls, stopReason: json.choices?.[0]?.finish_reason ?? "" };
}

// ---- Anthropic (native Messages API) ----

async function anthropicRunTool<T>(ep: LlmEndpoint, opts: { system: string; content: LlmContent; tool: ToolSpec; maxTokens?: number }): Promise<T | null> {
  const client = new Anthropic({ apiKey: ep.apiKey });
  const resp = await client.messages.create({
    model: ep.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.input_schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.content }],
  });
  for (const block of resp.content) {
    if (block.type === "tool_use" && block.name === opts.tool.name) return block.input as T;
  }
  return null;
}

// ---- OpenAI-compatible (OpenRouter / Ollama) ----

async function openAiRunTool<T>(ep: LlmEndpoint, opts: { system: string; content: LlmContent; tool: ToolSpec; maxTokens?: number }): Promise<T | null> {
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(ep),
    body: JSON.stringify({
      model: ep.model,
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
