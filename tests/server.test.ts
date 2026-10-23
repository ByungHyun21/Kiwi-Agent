// Server characterization tests: HTTP routing and the agent WebSocket protocol.
// These pin current behavior so the later module split stays behavior-neutral.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EvCat,
  EvDelta,
  EvDone,
  EvError,
  EvHello,
  EvHistory,
  EvPathComplete,
  EvSessions,
  EvState,
  EvStatus,
  MsgCat,
  MsgNew,
  MsgPathComplete,
  MsgProject,
  MsgResume,
  MsgSend,
  type Event,
} from "../src/shared/protocol.ts";
import { KiwiServer } from "../src/server/server.ts";
import { Conn } from "../src/server/ws.ts";
import type { Runner } from "../src/ssh.ts";
import { Store } from "../src/store.ts";

const runner: Runner = {
  async run(_machine, _workdir, argv) {
    if (argv[0] === "read") return { ok: false, code: "noent", message: "missing" };
    if (argv[0] === "ls") return { ok: true, data: "a.txt\nab.txt\n" };
    return { ok: true, data: "" };
  },
};

/** start boots a real kiwi-server (store + stub LLM + fake runner) on port 0. */
async function start(opts: { webDist?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-server-test-"));
  const dist = path.join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  await Bun.write(path.join(dist, "index.html"), "<!doctype html><title>kiwi-test</title>");
  const store = Store.open(path.join(dir, "server.db"));
  store.saveMachine({ name: "m", host: "h", port: 22, user: "u", state: "" });
  store.createProject({ id: 0, name: "p", machine: "m", workdir: "/w" });

  const llm = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/models") {
        return Response.json({ data: [{ id: "stub", context_length: 32768 }] });
      }
      const body = (await req.json()) as { stream?: boolean };
      if (!body.stream) return Response.json({ choices: [{ message: { content: "summary" } }] });
      const chunks = [
        { choices: [{ delta: { content: "안녕하세요" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ];
      const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  store.saveProvider({ name: "local", baseUrl: `http://127.0.0.1:${llm.port}` });
  store.setRole({ role: "agent-chat", provider: "local", model: "stub" });

  const srv = new KiwiServer(store, runner, {
    addr: ":0",
    dataDir: dir,
    searxngUrl: "",
    webDist: opts.webDist ?? dist,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => srv.handle(req, s),
    websocket: {
      open: (ws: Bun.ServerWebSocket<unknown>) => {
        (ws.data as Conn).attach(ws);
        (ws.data as Conn).onOpen();
      },
      message: (ws: Bun.ServerWebSocket<unknown>, message: string | Uint8Array) => (ws.data as Conn).onMessage(message),
      close: (ws: Bun.ServerWebSocket<unknown>) => (ws.data as Conn).onClose(),
    },
  });

  return {
    store,
    srv,
    server,
    llm,
    url: `http://127.0.0.1:${server.port}`,
    wsURL: `ws://127.0.0.1:${server.port}/ws`,
    close() {
      server.stop(true);
      llm.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** WSClient records events and lets tests await them by predicate. */
class WSClient {
  private ws: WebSocket;
  private events: Event[] = [];
  private waiters: { pred: (e: Event) => boolean; resolve: (e: Event) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const ev = JSON.parse(String(m.data)) as Event;
      const i = this.waiters.findIndex((w) => w.pred(ev));
      if (i < 0) {
        this.events.push(ev);
        return;
      }
      const w = this.waiters.splice(i, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(ev);
    };
  }

  static connect(url: string): Promise<WSClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new WSClient(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = () => reject(new Error("ws connect failed"));
    });
  }

  next(pred: (e: Event) => boolean, timeoutMs = 5000): Promise<Event> {
    const i = this.events.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`timeout waiting for event; buffered: ${this.events.map((e) => e.type).join(",")}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, fail: reject, timer });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.onmessage = null;
    this.ws.close();
  }
}

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

async function open(opts: { webDist?: string } = {}): Promise<{ ctx: Awaited<ReturnType<typeof start>>; ws: WSClient }> {
  const ctx = await start(opts);
  const ws = await WSClient.connect(ctx.wsURL);
  cleanups.push(() => {
    ws.close();
    ctx.close();
  });
  await ws.next((e) => e.type === EvHello);
  return { ctx, ws };
}

describe("websocket", () => {
  test("handshake, project, session, and one streaming turn", async () => {
    const { ctx, ws } = await open();
    await ws.next((e) => e.type === EvSessions);
    await ws.next((e) => e.type === EvState);

    ws.send({ type: MsgProject, text: "p" });
    await ws.next((e) => e.type === EvState && e.state?.project === "p");

    ws.send({ type: MsgNew, text: "" });
    const state = await ws.next((e) => e.type === EvState && (e.session ?? "") !== "");
    const session = state.session!;

    ws.send({ type: MsgSend, text: "안녕" });
    await ws.next((e) => e.type === EvStatus && e.name === "working");
    await ws.next((e) => e.type === EvDelta && e.text === "안녕하세요");
    await ws.next((e) => e.type === EvState && e.state?.ctxUsed === 7 && e.state?.ctxMax === 32768);
    await ws.next((e) => e.type === EvDone);
    await ws.next((e) => e.type === EvStatus && e.name === "idle");

    expect(ctx.store.messages(session).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ctx.store.session(session).ctxTokens).toBe(7);
  });

  test("send without a session is rejected", async () => {
    const { ws } = await open();
    ws.send({ type: MsgSend, text: "hi" });
    const ev = await ws.next((e) => e.type === EvError);
    expect(ev.error).toContain("선택된 세션이 없습니다");
  });

  test("resume replays the stored transcript", async () => {
    const { ctx, ws } = await open();
    const project = ctx.store.projectByName("p");
    const sess = ctx.store.newSession(project.id, "s");
    ctx.store.appendMessage(sess.id, { role: "user", content: "q" });
    ctx.store.appendMessage(sess.id, { role: "assistant", content: "a" });

    ws.send({ type: MsgResume, sessionId: sess.id });
    const history = await ws.next((e) => e.type === EvHistory);
    expect(history.session).toBe(sess.id);
    expect(history.history).toEqual([
      { kind: "user", text: "q" },
      { kind: "assistant", text: "a" },
    ]);
    await ws.next((e) => e.type === EvState && e.session === sess.id);
  });

  test("cat and path completion read through the runner", async () => {
    const { ctx, ws } = await open();
    const project = ctx.store.projectByName("p");
    const sess = ctx.store.newSession(project.id, "s");
    ws.send({ type: MsgResume, sessionId: sess.id });
    await ws.next((e) => e.type === EvHistory);

    ws.send({ type: MsgCat, text: "a.txt" });
    const cat = await ws.next((e) => e.type === EvCat);
    expect(cat.name).toBe("a.txt");

    ws.send({ type: MsgPathComplete, text: "a" });
    const done = await ws.next((e) => e.type === EvPathComplete);
    expect(done.candidates).toEqual(["a.txt", "ab.txt"]);
  });
});

describe("http routing", () => {
  test("health is public and unknown routes 404", async () => {
    const { ctx } = await open();
    const health = await fetch(ctx.url + "/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const missing = await fetch(ctx.url + "/api/nope");
    expect(missing.status).toBe(404);
  });

  test("machines and projects are listed", async () => {
    const { ctx } = await open();
    const machines = (await (await fetch(ctx.url + "/api/machines")).json()) as { name: string }[];
    expect(machines.map((m) => m.name)).toEqual(["m"]);
    const projects = (await (await fetch(ctx.url + "/api/projects")).json()) as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(["p"]);
  });

  test("serves the SPA with history fallback", async () => {
    const { ctx } = await open();
    const root = await fetch(ctx.url + "/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("kiwi-test");

    const deep = await fetch(ctx.url + "/projects/1");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("kiwi-test");

    expect((await fetch(ctx.url + "/missing.js")).status).toBe(404);
  });

  test("without a built SPA the UI returns a build hint", async () => {
    const { ctx } = await open({ webDist: "" });
    const res = await fetch(ctx.url + "/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build");
  });
});
