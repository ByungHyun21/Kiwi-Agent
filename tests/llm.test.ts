// LLM client tests: SSE streaming assembly against a local mock.

import { afterAll, describe, expect, test } from "bun:test";
import { Client, type Message } from "../src/llm.ts";

let server: Bun.Server<unknown>;

const chunks: string[] = [
  JSON.stringify({ choices: [{ delta: { content: "안녕" }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { reasoning_content: "생각" }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { reasoning: "추론" }, finish_reason: null }] }),
  JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: "{\"pa" } }] },
      finish_reason: null,
    }],
  }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"x\"}" } }] }, finish_reason: null }],
  }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
];

beforeAllServer();

function beforeAllServer(): void {
  server = Bun.serve({
    port: 0, // random port
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as { messages?: Message[]; stream?: boolean };
        expect(body.stream).toBe(true);
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(enc.encode(`data: ${ch}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "m1", context_length: 32768 }, { id: "m2", top_provider: { context_length: 8192 } }] });
      }
      if (url.pathname === "/v1/nonstream" || url.pathname.endsWith("/complete")) {
        return Response.json({ choices: [{ message: { content: "요약" } }] });
      }
      return new Response("nope", { status: 404 });
    },
  });
}

afterAll(() => {
  server.stop(true);
});

function clientFor(pathname: string): Client {
  return new Client(`http://localhost:${server.port}/v1${pathname}`, "test-key", "mock-model");
}

describe("llm client", () => {
  test("streamChat assembles content, reasoning, tool calls and usage", async () => {
    const c = clientFor("");
    const deltas: string[] = [];
    const resp = await c.streamChat(undefined, [{ role: "user", content: "hi" }], [], (kind, name, text) => {
      deltas.push(`${kind}:${name}:${text}`);
    });
    expect(resp.content).toBe("안녕");
    expect(resp.reasoning).toBe("생각추론");
    expect(resp.finish).toBe("tool_calls");
    expect(resp.usage.promptTokens).toBe(42);
    expect(resp.usage.completionTokens).toBe(7);
    expect(resp.toolCalls).toEqual([{ id: "c1", name: "write_file", args: '{"path":"x"}' }]);
    expect(deltas.some((d) => d.startsWith("content::안녕"))).toBe(true);
    expect(deltas.some((d) => d.startsWith("tool_args:write_file:"))).toBe(true);
  });

  test("listModels returns ids", async () => {
    const c = clientFor("");
    expect(await c.listModels()).toEqual(["m1", "m2"]);
  });

  test("listModelInfo reads context windows from common provider shapes", async () => {
    const c = new Client(`http://localhost:${server.port}/v1`, "", "m1");
    expect(await c.listModelInfo()).toEqual([
      { id: "m1", contextLength: 32768 },
      { id: "m2", contextLength: 8192 },
    ]);
    expect(await c.modelContextLength()).toBe(32768);
  });

  test("think levels map to vLLM/llama.cpp request fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bodies.push((await req.json()) as Record<string, unknown>);
        return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const c = new Client(`http://localhost:${s.port}/v1`, "", "m");
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    await c.streamChat(undefined, msgs, [], undefined, { think: "max" });
    await c.streamChat(undefined, msgs, [], undefined, { think: "off" });
    await c.streamChat(undefined, msgs, [], undefined, { think: "auto" });

    expect(bodies[0]!.reasoning_effort).toBe("max");
    expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(bodies[1]!.reasoning_effort).toBe("none");
    expect(bodies[1]!.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[2]!.reasoning_effort).toBeUndefined();
    expect(bodies[2]!.chat_template_kwargs).toBeUndefined();
    s.stop(true);
  });

  test("authorization header sent when key set", async () => {
    let seen = "";
    const s = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen = req.headers.get("Authorization") ?? "";
        return Response.json({ data: [] });
      },
    });
    const c = new Client(`http://localhost:${s.port}/v1`, "secret", "m");
    await c.listModels();
    expect(seen).toBe("Bearer secret");
    s.stop(true);
  });

  test("HTTP errors surface with status", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const c = new Client(`http://localhost:${s.port}/v1`, "", "m");
    await expect(c.listModels()).rejects.toThrow("500");
    s.stop(true);
  });
});
