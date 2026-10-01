// Minimal OpenAI-compatible chat client with streaming, tool calling and
// usage accounting, sufficient for kiwi-server.

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

/** Response is the assembled result of one completion. */
export interface Response {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finish: string;
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
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: convertMessages(msgs),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = convertTools(tools);

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
        if (delta.reasoning_content) {
          out.reasoning += delta.reasoning_content;
          onDelta?.("reasoning", "", delta.reasoning_content);
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

  /** ListModels returns the model IDs the endpoint advertises. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await fetch(this.baseURL + "/models", {
      headers: this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {},
      signal,
    });
    if (!resp.ok) throw new Error(`llm: ${resp.status}`);
    const out = (await resp.json()) as { data?: { id: string }[] };
    return (out.data ?? []).map((m) => m.id);
  }
}

interface SSEChunk {
  choices?: {
    delta?: {
      content?: string;
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
