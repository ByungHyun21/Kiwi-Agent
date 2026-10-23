// Minimal OpenAI-compatible chat client with streaming, tool calling and
// usage accounting, sufficient for kiwi-server.

import type { ThinkLevel } from "./shared/protocol.ts";

/** ToolCall is one tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  args: string; // raw JSON string
}

/** Message is one conversation entry. */
export interface Message {
  role: string; // system | user | assistant | tool
  content: string;
  toolCalls?: ToolCall[]; // assistant: calls to run
  toolCallID?: string; // tool: which call
  name?: string; // tool name
}

/** Tool defines one function the model may call. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Usage is token accounting from one completion. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** ModelInfo is one entry from the provider's model list. */
export interface ModelInfo {
  id: string;
  contextLength?: number;
}

/** Response is the assembled result of one completion. */
export interface Response {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finish: string;
}

/** StreamOptions controls provider-agnostic request extensions. */
export interface StreamOptions {
  think?: ThinkLevel;
}

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

interface ChatTool {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ModelCacheEntry {
  at: number;
  models: ModelInfo[];
}

const modelCache = new Map<string, ModelCacheEntry>();
const modelCacheTTL = 5 * 60_000;

/** Client talks to one OpenAI-compatible endpoint. */
export class Client {
  baseURL: string;
  apiKey: string;
  model: string;

  constructor(baseURL: string, apiKey: string, model: string) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
  }

  /** StreamChat calls chat/completions with stream=true, invoking onDelta
   *  for every reasoning and content chunk, and returns the assembled response. */
  async streamChat(
    signal: AbortSignal | undefined,
    msgs: Message[],
    tools: Tool[],
    onDelta?: (kind: string, name: string, text: string) => void,
    options?: StreamOptions,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(msgs),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = convertTools(tools);
    applyThink(body, options?.think);

    const resp = await fetch(this.baseURL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`llm: ${resp.status}: ${text.trim()}`);
    }
    if (!resp.body) throw new Error("llm: empty response body");

    const out: Response = {
      content: "",
      reasoning: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      finish: "",
    };
    const calls = new Map<number, ToolCall>();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "" || data === "[DONE]") continue;
        let chunk: SSEChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          out.usage.promptTokens = chunk.usage.prompt_tokens;
          out.usage.completionTokens = chunk.usage.completion_tokens;
        }
        if (!chunk.choices || chunk.choices.length === 0) continue;
        const ch = chunk.choices[0];
        if (ch.finish_reason != null) out.finish = ch.finish_reason;
        const delta = ch.delta ?? {};
        // vLLM streams `reasoning`; llama.cpp / DeepSeek use `reasoning_content`.
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) {
          out.reasoning += reasoning;
          onDelta?.("reasoning", "", reasoning);
        }
        if (delta.content) {
          out.content += delta.content;
          onDelta?.("content", "", delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
            calls.set(tc.index, call);
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name = tc.function.name;
          if (tc.function?.arguments) {
            call.args += tc.function.arguments;
            onDelta?.("tool_args", call.name, tc.function.arguments);
          }
        }
      }
    }
    for (let i = 0; i < calls.size; i++) {
      const call = calls.get(i);
      if (call && call.name) out.toolCalls.push(call);
    }
    return out;
  }

  /** Complete is a non-streaming convenience call (used for compaction). */
  async complete(signal: AbortSignal | undefined, msgs: Message[]): Promise<string> {
    const resp = await fetch(this.baseURL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}),
      },
      body: JSON.stringify({ model: this.model, messages: convertMessages(msgs) }),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`llm: ${resp.status}: ${text.trim()}`);
    }
    const out = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    if (!out.choices || out.choices.length === 0) throw new Error("llm: empty response");
    return out.choices[0].message?.content ?? "";
  }

  /** ListModelInfo returns the model entries and their context windows.
   *  refresh=true bypasses the short-lived model list cache. */
  async listModelInfo(signal?: AbortSignal, refresh = false): Promise<ModelInfo[]> {
    const cached = modelCache.get(this.baseURL);
    if (!refresh && cached && Date.now() - cached.at < modelCacheTTL) return cached.models;
    const resp = await fetch(this.baseURL + "/models", {
      headers: this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {},
      signal,
    });
    if (!resp.ok) throw new Error(`llm: ${resp.status}`);
    const out = (await resp.json()) as { data?: unknown[]; models?: unknown[] };
    const raw = Array.isArray(out.data) ? out.data : Array.isArray(out.models) ? out.models : [];
    const models: ModelInfo[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
      if (id === "") continue;
      const contextLength = parseContextLength(row);
      models.push(contextLength === undefined ? { id } : { id, contextLength });
    }
    modelCache.set(this.baseURL, { at: Date.now(), models });
    return models;
  }

  /** ListModels returns the model IDs the endpoint advertises. */
  async listModels(signal?: AbortSignal, refresh = false): Promise<string[]> {
    return (await this.listModelInfo(signal, refresh)).map((m) => m.id);
  }

  /** ModelContextLength returns this client model's context window, 0 when unknown. */
  async modelContextLength(signal?: AbortSignal): Promise<number> {
    try {
      const models = await this.listModelInfo(signal);
      return models.find((m) => m.id === this.model)?.contextLength ?? 0;
    } catch {
      return 0;
    }
  }
}

/** cachedModelContext reads a context window already discovered via /models. */
export function cachedModelContext(baseURL: string, model: string): number {
  const cached = modelCache.get(baseURL.replace(/\/+$/, ""));
  return cached?.models.find((m) => m.id === model)?.contextLength ?? 0;
}

/** parseContextLength reads the context window from common provider shapes. */
function parseContextLength(row: Record<string, unknown>): number | undefined {
  const paths: string[][] = [
    ["context_length"],
    ["context_window"],
    ["max_context_length"],
    ["max_model_len"],
    ["max_input_tokens"],
    ["max_sequence_length"],
    ["model_max_length"],
    ["n_ctx"],
    ["top_provider", "context_length"],
    ["meta", "n_ctx_train"],
    ["meta", "n_ctx"],
    ["capabilities", "context_length"],
    ["limits", "context_length"],
  ];
  for (const path of paths) {
    let cur: unknown = row;
    for (const key of path) {
      if (typeof cur !== "object" || cur === null) {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === "number" && Number.isFinite(cur) && cur > 0) return Math.floor(cur);
    if (typeof cur === "string") {
      const n = parseInt(cur, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

interface SSEChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** applyThink maps one session level to the request fields understood by
 *  both vLLM and llama.cpp: chat_template_kwargs controls template-level
 *  thinking, reasoning_effort carries level/off semantics. */
function applyThink(body: Record<string, unknown>, think: ThinkLevel | undefined): void {
  if (!think || think === "auto") return;
  if (think === "off") {
    body.chat_template_kwargs = { enable_thinking: false };
    body.reasoning_effort = "none";
    return;
  }
  body.chat_template_kwargs = { enable_thinking: true };
  if (think !== "on") body.reasoning_effort = think;
}

function convertMessages(msgs: Message[]): ChatMessage[] {
  return msgs.map((m) => {
    const cm: ChatMessage = {
      role: m.role,
      content: m.content !== "" ? m.content : null,
    };
    if (m.role === "tool") cm.content = m.content; // tool results are plain strings
    if (m.toolCallID) cm.tool_call_id = m.toolCallID;
    if (m.name) cm.name = m.name;
    if (m.toolCalls && m.toolCalls.length > 0) {
      cm.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return cm;
  });
}

function convertTools(tools: Tool[]): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
