import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/** Provider-neutral tool/message types for the web-agent loop. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type NeutralMsg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface TurnResult {
  text: string;
  toolCalls: LlmToolCall[];
}

/** One model turn: given the system prompt, history, and tools, return text + tool calls. */
export type ModelTurn = (system: string, history: NeutralMsg[], tools: LlmTool[]) => Promise<TurnResult>;

/** Pick the turn implementation + resolved model name for the configured provider. */
export function getModelTurn(): { turn: ModelTurn; model: string; label: string } {
  if (config.webAgent.provider === "openai-compatible") {
    const model = config.webAgent.model || "qwen2.5";
    return { turn: openAiCompatibleTurn(model), model, label: `openai-compatible(${model})` };
  }
  const model = config.webAgent.model || "claude-opus-4-8";
  return { turn: anthropicTurn(model), model, label: `anthropic(${model})` };
}

// ---- Anthropic (Claude) ----

function anthropicTurn(model: string): ModelTurn {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  return async (system, history, tools) => {
    const resp = await client.messages.create({
      model,
      max_tokens: 4000,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      messages: toAnthropicMessages(history),
    });
    let text = "";
    const toolCalls: LlmToolCall[] = [];
    for (const block of resp.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
    }
    return { text, toolCalls };
  };
}

function toAnthropicMessages(history: NeutralMsg[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      i++;
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      out.push({ role: "assistant", content });
      i++;
    } else {
      // Merge consecutive tool results into one user message.
      const results: Anthropic.ContentBlockParam[] = [];
      while (i < history.length && history[i].role === "tool") {
        const t = history[i] as Extract<NeutralMsg, { role: "tool" }>;
        results.push({ type: "tool_result", tool_use_id: t.toolCallId, content: t.content });
        i++;
      }
      out.push({ role: "user", content: results });
    }
  }
  return out;
}

// ---- OpenAI-compatible (Ollama, etc.) ----

function openAiCompatibleTurn(model: string): ModelTurn {
  return async (system, history, tools) => {
    const messages = [
      { role: "system", content: system },
      ...history.map(toOpenAiMessage),
    ];
    const res = await fetch(`${config.webAgent.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.webAgent.apiKey ? { Authorization: `Bearer ${config.webAgent.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: "auto",
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      choices: { message: { content?: string; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = json.choices?.[0]?.message ?? { content: "" };
    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc, idx) => ({
      id: tc.id || `call_${idx}`,
      name: tc.function.name,
      args: safeParse(tc.function.arguments),
    }));
    return { text: msg.content ?? "", toolCalls };
  };
}

function toOpenAiMessage(m: NeutralMsg): Record<string, unknown> {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content ?? "", // some OpenAI-compatible servers (Ollama) reject null content
      ...(m.toolCalls.length
        ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }
        : {}),
    };
  }
  return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
