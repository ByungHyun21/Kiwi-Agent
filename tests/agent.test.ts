// Agent core tests: diff, path safety, tool execution.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lcsDiff, unifiedDiff } from "../src/server/agent/diff.ts";
import { Agent } from "../src/server/agent/loop.ts";
import { safePath, tokenize } from "../src/server/agent/paths.ts";
import { Store } from "../src/store.ts";
import type { Client, Response, Tool, ToolCall } from "../src/llm.ts";
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
  baseURL = "";
  apiKey = "";
  model = "";
  constructor(private responses: Response[]) {}
  async streamChat(): Promise<Response> {
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

function makeRunner(): Runner & { log: string[]; maxActive: () => number } {
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

function respWith(calls: ToolCall[]): Response {
  return { content: "", reasoning: "", toolCalls: calls, usage: { promptTokens: 1, completionTokens: 1 }, finish: "tool_calls" };
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
