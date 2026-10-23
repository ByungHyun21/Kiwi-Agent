// SessionRuntime tests: turn/queue/abort orchestration and session commands,
// exercised against a stub host instead of a WebSocket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent } from "../src/server/agent/loop.ts";
import { SessionRuntime, type SessionHost } from "../src/server/session.ts";
import {
  EvCat,
  EvDelta,
  EvDone,
  EvError,
  EvHistory,
  EvNotice,
  EvPathComplete,
  EvState,
  EvStatus,
  type Event,
  type Machine,
  type ThinkLevel,
} from "../src/shared/protocol.ts";
import { Store } from "../src/store.ts";

const machine: Machine = { name: "m", host: "h", port: 22, user: "u", state: "" };

let store: Store;
let dir: string;

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** setup wires a runtime with a real store and a scriptable fake agent. */
function setup() {
  dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-runtime-"));
  store = Store.open(path.join(dir, "server.db"));
  store.saveMachine(machine);

  const events: Event[] = [];
  const calls: string[] = [];
  let turnImpl: (signal: AbortSignal | undefined, text: string) => Promise<void> = async () => {};

  const agentEmit: { fn?: (e: Event) => void } = {};
  const agent = {
    get emit(): ((e: Event) => void) | undefined {
      return agentEmit.fn;
    },
    set emit(fn: ((e: Event) => void) | undefined) {
      agentEmit.fn = fn;
    },
    async turn(signal: AbortSignal | undefined, _sessionID: string, text: string): Promise<void> {
      calls.push(text);
      agentEmit.fn?.({ type: EvDelta, text: "echo:" + text });
      await turnImpl(signal, text);
    },
    async compact(): Promise<void> {},
    shouldCompact(): boolean {
      return false;
    },
    llm: {
      async streamChat(_s: unknown, _m: unknown, _t: unknown, cb?: (kind: string, name: string, text: string) => void): Promise<void> {
        cb?.("content", "", "side-answer");
      },
    },
  } as unknown as Agent;

  const runner = {
    async run(_m: Machine, _workdir: string, argv: string[]) {
      if (argv[0] === "read") return { ok: true, data: "file-body" };
      return { ok: true, data: "a.txt\nb.txt\n" };
    },
  };

  const host: SessionHost = {
    store,
    runner,
    agentFor: () => agent,
    panelState: (sessionID, projectName) => {
      let think: ThinkLevel = "auto";
      try {
        think = store.session(sessionID).think;
      } catch {
        // no active session yet
      }
      return {
        project: projectName,
        machine: "m",
        model: "stub",
        goal: "",
        ctxUsed: 0,
        ctxMax: 128000,
        think,
      };
    },
    execFor: () => ({ machine, workdir: "/w" }),
  };

  const runtime = new SessionRuntime(host, (e) => events.push(e));
  const project = store.createProject({ id: 0, name: "p", machine: "m", workdir: "/w" });
  const session = store.newSession(project.id, "s");

  return {
    runtime,
    events,
    calls,
    project,
    session,
    setTurn(fn: (signal: AbortSignal | undefined, text: string) => Promise<void>): void {
      turnImpl = fn;
    },
    agent,
  };
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error("timeout waiting for runtime event");
    await Bun.sleep(5);
  }
}

describe("SessionRuntime", () => {
  test("selects a project and creates a session", () => {
    const { runtime, events } = setup();
    runtime.selectProject("p");
    expect(events.some((e) => e.type === EvState && e.state?.project === "p")).toBe(true);

    runtime.newSession("");
    const state = events.find((e) => e.type === EvState && (e.session ?? "") !== "");
    expect(state?.session).toBeTruthy();
    expect(runtime.proj).toBe("p");
  });

  test("rejects send and new-session before selection", () => {
    const { runtime, events } = setup();
    runtime.send("hi");
    runtime.newSession("");
    const errors = events.filter((e) => e.type === EvError);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.error).toContain("선택된 세션이 없습니다");
    expect(errors[1]!.error).toContain("프로젝트를 선택하세요");
  });

  test("resume replays history", () => {
    const { runtime, events, session } = setup();
    store.appendMessage(session.id, { role: "user", content: "q" });
    store.appendMessage(session.id, { role: "assistant", content: "a" });

    runtime.resume(session.id);
    const history = events.find((e) => e.type === EvHistory);
    expect(history?.history).toEqual([
      { kind: "user", text: "q" },
      { kind: "assistant", text: "a" },
    ]);
  });

  test("/think changes the session level without calling the agent", () => {
    const { runtime, events, calls, session } = setup();
    runtime.resume(session.id);

    runtime.send("/think max");
    expect(store.session(session.id).think).toBe("max");
    expect(calls).toHaveLength(0);
    expect(events.some((e) => e.type === EvNotice && e.text === "추론 레벨: max")).toBe(true);
    expect(events.some((e) => e.type === EvState && e.state?.think === "max")).toBe(true);
    expect(store.messages(session.id)).toEqual([]);

    runtime.send("/think nope");
    expect(store.session(session.id).think).toBe("max");
    expect(events.some((e) => e.type === EvError && (e.error ?? "").includes("사용법"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("/think is handled while a turn is streaming instead of being queued", async () => {
    const { runtime, events, calls, session, setTurn } = setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTurn(async (_signal, text) => {
      if (text === "long") await gate;
    });

    runtime.resume(session.id);
    runtime.send("long");
    await waitFor(() => events.some((e) => e.type === EvStatus && e.name === "working"));

    runtime.send("/think high");
    expect(store.session(session.id).think).toBe("high");
    expect(calls).toEqual(["long"]);
    expect(events.some((e) => e.type === EvNotice && e.text === "추론 레벨: high")).toBe(true);

    release();
    await waitFor(() => events.some((e) => e.type === EvDone));
  });

  test("resume replays stored reasoning before the assistant content", () => {
    const { runtime, events, session } = setup();
    store.appendMessage(session.id, { role: "user", content: "q" });
    store.appendMessage(session.id, { role: "assistant", content: "a", reasoning: "why" });

    runtime.resume(session.id);
    const history = events.find((e) => e.type === EvHistory);
    expect(history?.history).toEqual([
      { kind: "user", text: "q" },
      { kind: "reasoning", text: "why" },
      { kind: "assistant", text: "a" },
    ]);
  });

  test("drains prompts queued while a turn is running", async () => {
    const { runtime, events, calls, session, setTurn } = setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTurn(async (_signal, text) => {
      if (text === "first") await gate;
    });

    runtime.resume(session.id);
    runtime.send("first");
    await waitFor(() => events.some((e) => e.type === EvDelta && e.text === "echo:first"));
    runtime.send("second");
    expect(events.some((e) => e.type === EvStatus && e.name === "queued")).toBe(true);

    release();
    await waitFor(() => events.filter((e) => e.type === EvDone).length === 2);
    expect(calls).toEqual(["first", "second"]);
    expect(events.some((e) => e.type === EvStatus && e.name === "idle")).toBe(true);
  });

  test("stop aborts the running turn", async () => {
    const { runtime, events, session, setTurn } = setup();
    setTurn(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    runtime.resume(session.id);
    runtime.send("long");
    await waitFor(() => events.some((e) => e.type === EvStatus && e.name === "working"));
    runtime.stop();
    await waitFor(() => events.some((e) => e.type === EvStatus && e.name === "stopped"));
    await waitFor(() => events.some((e) => e.type === EvStatus && e.name === "idle"));
  });

  test("workdir and machine changes are persisted", () => {
    const { runtime, events, session } = setup();
    runtime.resume(session.id);

    runtime.setWorkdir("/w2");
    expect(store.sessionLocation(session.id).workdir).toBe("/w2");
    expect(events.some((e) => e.type === EvStatus && e.name === "session-moved")).toBe(true);

    runtime.setMachine("nope");
    expect(events.some((e) => e.type === EvError && (e.error ?? "").includes("등록되지 않은 머신"))).toBe(true);

    runtime.setMachine("m");
    expect(store.sessionLocation(session.id).machine).toBe("m");
    expect(events.some((e) => e.type === EvStatus && e.name === "session-host-moved")).toBe(true);
  });

  test("cat and path completion read through the runner", async () => {
    const { runtime, events, session } = setup();
    runtime.resume(session.id);

    await runtime.cat("a.txt");
    expect(events.find((e) => e.type === EvCat)?.result).toBe("file-body");

    await runtime.pathComplete("a");
    expect(events.find((e) => e.type === EvPathComplete)?.candidates).toEqual(["a.txt"]);
  });
});
