// Agent core tests: diff, path safety, tool execution.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lcsDiff, unifiedDiff } from "../src/server/agent/diff.ts";
import { Agent } from "../src/server/agent/loop.ts";
import { safePath, tokenize } from "../src/server/agent/paths.ts";
import { Store } from "../src/store.ts";
import type { Client, Message, Response, StreamOptions, Tool, ToolCall } from "../src/llm.ts";
import type { Runner } from "../src/ssh.ts";
import type { ExecResult, Machine } from "../src/shared/protocol.ts";

describe("tokenize", () => {
  test("splits on whitespace and honors quotes", () => {
    expect(tokenize("python3 main.py")).toEqual(["python3", "main.py"]);
    expect(tokenize('echo "hello world"')).toEqual(["echo", "hello world"]);
    expect(tokenize("grep 'a b' file")).toEqual(["grep", "a b", "file"]);
    expect(tokenize("  a   b  ")).toEqual(["a", "b"]);
    expect(tokenize("")).toEqual([]);
  });
});

class ScriptedLLM implements Client {
  public calls = 0;
  public seen: Message[][] = [];
  baseURL = "";
  apiKey = "";
  model = "";
  constructor(private responses: Response[]) {}
  async streamChat(
    _signal: AbortSignal | undefined,
    msgs: Message[],
    _tools: Tool[],
    _onDelta?: (kind: string, name: string, text: string) => void,
    _options?: StreamOptions,
  ): Promise<Response> {
    this.seen.push(msgs.map((m) => ({ ...m })));
    const r = this.responses[this.calls] ?? { content: "done", reasoning: "", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, finish: "stop" };
    this.calls++;
    return r;
  }
  async complete(): Promise<string> {
    return "요약";
  }
  async listModelInfo(): Promise<{ id: string; contextLength?: number }[]> {
    return [];
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async modelContextLength(): Promise<number> {
    return 0;
  }
}

function makeRunner(opts: { agents?: { text: string } } = {}): Runner & { log: string[]; maxActive: () => number } {
  let active = 0;
  let max = 0;
  const log: string[] = [];
  const runner: Runner = {
    async run(_machine: Machine, _workdir: string, argv: string[]): Promise<ExecResult> {
      active++;
      max = Math.max(max, active);
      log.push(argv.join(" "));
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (argv[0] === "read" && argv[1] === "AGENTS.md" && opts.agents) {
        return { ok: true, data: opts.agents.text };
      }
      return { ok: true, data: "[" + argv.join(" ") + "]" };
    },
  };
  return Object.assign(runner, { log, maxActive: () => max });
}

function makeAgent(llm: Client, runner: Runner): { agent: Agent; store: Store; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-agent-"));
  const store = Store.open(path.join(dir, "server.db"));
  store.saveMachine({ name: "m", host: "h", port: 22, user: "u", state: "" });
  const p = store.createProject({ id: 0, name: "p", machine: "m", workdir: "/w" });
  const sess = store.newSession(p.id, "s");
  const machine: Machine = { name: "m", host: "h", port: 22, user: "u", state: "" };
  const agent = new Agent({ llm, runner, machine, workdir: "/w", store });
  (agent as unknown as { sessID?: string }).sessID = sess.id;
  return { agent, store, dir };
}

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args: JSON.stringify(args) };
}

function respWith(calls: ToolCall[], reasoning = ""): Response {
  return { content: "", reasoning, toolCalls: calls, usage: { promptTokens: 1, completionTokens: 1 }, finish: "tool_calls" };
}

function textResp(content: string, reasoning = ""): Response {
  return { content, reasoning, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, finish: "stop" };
}

describe("agent tool batch", () => {
  test("read-only batch runs in parallel", async () => {
    const llm = new ScriptedLLM([
      respWith([tc("1", "read_file", { path: "a.txt" }), tc("2", "glob", { pattern: "*.py" })]),
    ]);
    const runner = makeRunner();
    const { agent, store, dir } = makeAgent(llm, runner);
    const p = store.projects()[0]!;
    const sess = store.newSession(p.id, "s");
    await agent.turn(undefined, sess.id, "작업");
    expect(runner.maxActive()).toBe(2);
    const msgs = store.messages(sess.id);
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallID)).toEqual(["1", "2"]);
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  test("mixed batch stays sequential", async () => {
    const llm = new ScriptedLLM([
      respWith([tc("1", "write_file", { path: "a.txt", content: "x" }), tc("2", "read_file", { path: "a.txt" })]),
    ]);
    const runner = makeRunner();
    const { agent, store, dir } = makeAgent(llm, runner);
    const p = store.projects()[0]!;
    const sess = store.newSession(p.id, "s");
    await agent.turn(undefined, sess.id, "작업");
    expect(runner.maxActive()).toBe(1);
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  test("replays reasoning inside the current turn but not on the next user turn", async () => {
    const llm = new ScriptedLLM([
      respWith([tc("1", "read_file", { path: "a.txt" })], "first plan"),
      textResp("done", "final plan"),
      textResp("next done", "next plan"),
    ]);
    const runner = makeRunner();
    const { agent, store, dir } = makeAgent(llm, runner);
    const p = store.projects()[0]!;
    const sess = store.newSession(p.id, "s");

    await agent.turn(undefined, sess.id, "first");
    expect(llm.seen[0]!.some((m) => m.reasoning)).toBe(false);
    expect(llm.seen[1]!.find((m) => m.role === "assistant")?.reasoning).toBe("first plan");

    const stored = store.messages(sess.id);
    expect(stored.find((m) => m.role === "assistant" && m.toolCalls)?.reasoning).toBe("first plan");
    expect(stored.filter((m) => m.role === "assistant").at(-1)?.reasoning).toBe("final plan");

    await agent.turn(undefined, sess.id, "second");
    expect(llm.seen[2]!.some((m) => m.reasoning)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  test("edit tool shows diff", async () => {
    const llm = new ScriptedLLM([
      respWith([tc("1", "edit", { path: "f.txt", edits: [{ oldText: "a", newText: "b" }] })]),
    ]);
    const runner = makeRunner();
    const { agent, store, dir } = makeAgent(llm, runner);
    const p = store.projects()[0]!;
    const sess = store.newSession(p.id, "s");
    await agent.turn(undefined, sess.id, "작업");
    expect(runner.log).toEqual(["read AGENTS.md", "read f.txt", "edit f.txt"]);
    const toolMsg = store.messages(sess.id).find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("수정됨");
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });
});

describe("agent context snapshot", () => {
  test("keeps the system prefix stable, appends AGENTS diffs, and refreshes on compact/idle", async () => {
    const agents = { text: "rule v1" };
    const llm = new ScriptedLLM([
      textResp("one"),
      textResp("two"),
      textResp("three"),
    ]);
    const runner = makeRunner({ agents });
    const { agent, store, dir } = makeAgent(llm, runner);
    const p = store.projects()[0]!;
    const sess = store.newSession(p.id, "s");

    await agent.turn(undefined, sess.id, "first");
    expect(store.session(sess.id).systemText).toContain("rule v1");
    expect(store.session(sess.id).agentsText).toBe("rule v1");
    expect(llm.seen[0]!.find((m) => m.role === "system")?.content).toContain("rule v1");

    agents.text = "rule v2\nnew line";
    await agent.turn(undefined, sess.id, "second");
    const active = store.session(sess.id);
    expect(active.systemText).toContain("rule v1");
    expect(active.systemText).not.toContain("rule v2");
    expect(active.agentsText).toBe("rule v2\nnew line");
    expect(store.messages(sess.id).some((m) => m.hidden)).toBe(true);
    expect(llm.seen[1]!.find((m) => m.role === "system")?.content).toContain("rule v1");
    expect(llm.seen[1]!.some((m) => m.role === "user" && m.content.includes("+ rule v2"))).toBe(true);

    await agent.compact(undefined, sess.id);
    expect(store.session(sess.id).systemText).toContain("rule v2");
    expect(store.messages(sess.id).some((m) => m.hidden)).toBe(false);

    store.setLastOutputAt(sess.id, 1);
    agents.text = "rule v3";
    await agent.turn(undefined, sess.id, "third");
    const idle = store.session(sess.id);
    expect(idle.systemText).toContain("rule v3");
    expect(idle.agentsText).toBe("rule v3");
    expect(store.messages(sess.id).some((m) => m.hidden)).toBe(false);
    expect(llm.seen[2]!.find((m) => m.role === "system")?.content).toContain("rule v3");

    rmSync(dir, { recursive: true, force: true });
    store.close();
  });
});

describe("safePath", () => {
  test("accepts relative paths", () => {
    expect(safePath("index.html")).toBe(true);
    expect(safePath("a/b/c.txt")).toBe(true);
    expect(safePath("./x")).toBe(true);
  });
  test("rejects absolute and traversal paths", () => {
    expect(safePath("")).toBe(false);
    expect(safePath("/etc/passwd")).toBe(false);
    expect(safePath("..")).toBe(false);
    expect(safePath("../outside")).toBe(false);
    expect(safePath("a/../../b")).toBe(false);
  });
});

describe("unifiedDiff", () => {
  test("new file shows full content as additions", () => {
    const d = unifiedDiff("hello.txt", "", "a\nb\n");
    expect(d).toContain("--- hello.txt");
    expect(d).toContain("+++ hello.txt");
    expect(d).toContain("+ a");
    expect(d).toContain("+ b");
    // deletions only carry the empty sentinel line (matches the Go original)
    expect(d.split("\n").filter((ln) => ln.startsWith("- ")).every((ln) => ln === "- ")).toBe(true);
  });

  test("change shows mixed +/- lines", () => {
    const d = unifiedDiff("f.txt", "a\nb\nc", "a\nx\nc");
    expect(d).toContain("- b");
    expect(d).toContain("+ x");
    expect(d).not.toContain("+ a");
    expect(d).not.toContain("- a");
  });

  test("no change", () => {
    expect(unifiedDiff("f.txt", "same", "same\n")).toContain("변경 없음");
  });
});

describe("lcsDiff", () => {
  test("basic ops", () => {
    const ops = lcsDiff(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops).toEqual([
      { op: "-", text: "b" },
      { op: "+", text: "x" },
    ]);
  });
  test("pure insert", () => {
    const ops = lcsDiff(["a"], ["a", "b"]);
    expect(ops).toEqual([{ op: "+", text: "b" }]);
  });
  test("pure delete", () => {
    const ops = lcsDiff(["a", "b"], []);
    expect(ops).toEqual([{ op: "-", text: "a" }, { op: "-", text: "b" }]);
  });
});
