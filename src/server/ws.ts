// The agent WebSocket endpoint: one TUI connection with its session runtime.

import {
  EvDelta,
  EvDone,
  EvError,
  EvHello,
  EvHistory,
  EvReasoning,
  EvBtwSides,
  EvCat,
  EvPathComplete,
  EvSessions,
  EvState,
  EvStatus,
  HistoryEntry,
  MsgBtw,
  MsgBtwSides,
  MsgCat,
  MsgPathComplete,
  MsgSessionCd,
  MsgSessionHost,
  MsgCompact,
  MsgNew,
  MsgProject,
  MsgResume,
  MsgSend,
  MsgSessions,
  MsgSetGoal,
  MsgState,
  MsgStop,
  type ClientMsg,
  type Event,
  type PanelState,
  type SessionInfo,
} from "../protocol.ts";
import { Agent, safePath, systemPromptText } from "../agent.ts";
import type { Message } from "../store.ts";
import type { KiwiServer } from "./server.ts";

/** Conn is one TUI WebSocket connection with its session runtime. */
export class Conn {
  srv: KiwiServer;
  ws: Bun.ServerWebSocket<unknown> | null = null;
  sess = ""; // current session id
  projID = 0; // selected project
  proj = ""; // selected project name
  busy = false;
  cancel: AbortController | null = null;

  constructor(srv: KiwiServer) {
    this.srv = srv;
  }

  // ---- wiring for Bun.serve websocket handlers ----

  attach(ws: Bun.ServerWebSocket<unknown>): void {
    this.ws = ws;
  }

  onOpen(): void {
    this.send({ type: EvHello });
    this.pushSessions(0);
    this.pushState();
  }

  onMessage(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data) as ClientMsg;
    } catch {
      return;
    }
    this.handle(msg);
  }

  onClose(): void {
    this.ws = null;
    this.cancel?.abort();
  }

  send(e: Event): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(e));
    } catch (err) {
      console.error("ws write:", err);
    }
  }

  handle(msg: ClientMsg): void {
    switch (msg.type) {
      case MsgSend: {
        if (this.sess === "") {
          this.send({ type: EvError, error: "선택된 세션이 없습니다. /project 또는 /new 로 시작하세요." });
          return;
        }
        if (this.busy) {
          this.srv.store.enqueue(this.sess, msg.text ?? "");
          this.send({ type: EvStatus, name: "queued" });
          return;
        }
        this.runTurn(msg.text ?? "");
        return;
      }
      case MsgStop:
        this.cancel?.abort();
        return;
      case MsgProject: {
        try {
          const p = this.srv.store.projectByName(msg.text ?? "");
          this.projID = p.id;
          this.proj = p.name;
        } catch {
          // unknown project: keep current
        }
        this.pushState();
        this.pushSessions(this.projID);
        return;
      }
      case MsgNew: {
        const pID = this.projID;
        if (pID === 0) {
          this.send({ type: EvError, error: "먼저 프로젝트를 선택하세요 (/project)." });
          return;
        }
        try {
          const sess = this.srv.store.newSession(pID, msg.text ?? "");
          this.sess = sess.id;
        } catch (err) {
          this.send({ type: EvError, error: String(err) });
          return;
        }
        this.pushSessions(pID);
        this.pushState();
        return;
      }
      case MsgResume: {
        try {
          const sess = this.srv.store.session(msg.sessionId ?? "");
          this.sess = sess.id;
          try {
            const p = this.srv.store.project(sess.projectId);
            this.projID = p.id;
            this.proj = p.name;
          } catch {
            // ignore
          }
        } catch {
          this.send({ type: EvError, error: "세션을 찾을 수 없습니다: " + (msg.sessionId ?? "") });
          return;
        }
        this.pushHistory();
        this.pushState();
        this.pushSessions(this.projID);
        return;
      }
      case MsgSessions:
        this.pushSessions(this.currentProject());
        return;
      case MsgState:
        this.pushState();
        return;
      case MsgSetGoal:
        if (this.sess === "") return;
        this.srv.store.setGoal(this.sess, msg.text ?? "");
        this.pushState();
        return;
      case MsgCompact:
        this.runCompact();
        return;
      case MsgBtw:
        if (this.sess === "") return;
        this.runBtw(msg.text ?? "", msg.sessionId);
        return;
      case MsgBtwSides:
        this.send({ type: EvBtwSides, sessions: this.srv.store.btwSides(this.sess) });
        return;
      case MsgSessionCd: {
        const p = msg.text ?? "";
        if (this.sess === "" || p === "") return;
        this.srv.store.setSessionLocation(this.sess, { workdir: p });
        this.pushState();
        this.send({ type: EvStatus, name: "session-moved" });
        return;
      }
      case MsgSessionHost: {
        const name = msg.text ?? "";
        if (this.sess === "" || name === "") return;
        try {
          this.srv.store.machine(name);
        } catch {
          this.send({ type: EvError, error: "등록되지 않은 머신: " + name });
          return;
        }
        this.srv.store.setSessionLocation(this.sess, { machine: name });
        this.pushState();
        this.send({ type: EvStatus, name: "session-host-moved" });
        return;
      }
      case MsgCat:
        void this.runCat(msg.text ?? "");
        return;
      case MsgPathComplete:
        void this.runPathComplete(msg.text ?? "");
        return;
    }
  }

  /** runCat streams a file into the TUI viewer without touching the agent context. */
  private async runCat(p: string): Promise<void> {
    if (!safePath(p)) {
      this.send({ type: EvCat, name: p, result: "", error: "경로는 작업 폴더 안의 상대 경로여야 합니다: " + p });
      return;
    }
    let loc;
    try {
      loc = this.srv.execFor(this.sess, this.projID);
    } catch (err) {
      this.send({ type: EvCat, name: p, result: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const res = await this.srv.runner.run(loc.machine, loc.workdir, ["read", p], null, undefined);
    if (!res.ok) this.send({ type: EvCat, name: p, result: "", error: `오류 (${res.code}): ${res.message}` });
    else this.send({ type: EvCat, name: p, result: res.data ?? "" });
  }

  /** runPathComplete returns ls-based path candidates for tab completion. */
  private async runPathComplete(partial: string): Promise<void> {
    if (partial.startsWith("/") || partial.includes("..")) {
      this.send({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const slash = partial.lastIndexOf("/");
    const dir = slash >= 0 ? partial.slice(0, slash + 1) : "";
    const prefix = slash >= 0 ? partial.slice(slash + 1) : partial;
    let loc;
    try {
      loc = this.srv.execFor(this.sess, this.projID);
    } catch {
      this.send({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const res = await this.srv.runner.run(loc.machine, loc.workdir, dir === "" ? ["ls"] : ["ls", dir], null, undefined);
    if (!res.ok) {
      this.send({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const candidates = (res.data ?? "").split("\n").filter((n) => n !== "" && n.startsWith(prefix)).slice(0, 20).map((n) => dir + n);
    this.send({ type: EvPathComplete, text: partial, candidates });
  }

  /** runTurn executes one agent turn, auto-compacts if needed, drains the queue. */
  runTurn(text: string): void {
    void this._runTurn(text);
  }

  private async _runTurn(text: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.srv.agentFor(this.sess);
    } catch (err) {
      this.send({ type: EvError, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let lastState: PanelState | undefined;
    agent.emit = (e: Event) => {
      if (e.state) lastState = e.state;
      this.send(e);
    };

    this.busy = true;
    const ac = new AbortController();
    this.cancel = ac;
    this.send({ type: EvStatus, name: "working" });
    try {
      // drain loop: one turn, then any prompts queued while busy
      for (;;) {
        try {
          await agent.turn(ac.signal, this.sess, text);
        } catch (err) {
          if (!ac.signal.aborted) {
            this.send({ type: EvError, error: err instanceof Error ? err.message : String(err) });
          } else {
            this.send({ type: EvStatus, name: "stopped" });
          }
        }
        if (lastState && agent.shouldCompact(lastState.ctxUsed, lastState.ctxMax)) {
          try {
            await agent.compact(undefined, this.sess);
            this.send({ type: EvStatus, name: "compacted" });
          } catch {
            // compaction failures are non-fatal
          }
        }
        this.send({ type: EvDone });
        this.send({ type: EvStatus, name: "idle" });
        this.pushSessions(this.currentProject());

        const next = this.srv.store.dequeue(this.sess);
        if (next == null) break;
        text = next;
        ac.signal.throwIfAborted();
      }
    } catch {
      // aborted while draining the queue
    } finally {
      this.cancel = null;
      this.busy = false;
    }
  }

  private async runCompact(): Promise<void> {
    if (this.sess === "" || this.busy) return;
    let agent: Agent;
    try {
      agent = this.srv.agentFor(this.sess);
    } catch (err) {
      this.send({ type: EvError, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    agent.emit = (e) => this.send(e);
    this.busy = true;
    try {
      await agent.compact(undefined, this.sess);
      this.send({ type: EvStatus, name: "compacted" });
      this.pushState();
    } catch (err) {
      this.send({ type: EvError, error: "compact 실패: " + (err instanceof Error ? err.message : String(err)) });
    } finally {
      this.busy = false;
    }
  }

  private async runBtw(text: string, sideId?: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.srv.agentFor(this.sess);
    } catch {
      return;
    }
    let target = "";
    const msgs: Message[] = [{ role: "system", content: systemPromptText() }];
    const boundTail = (sid: string): Message[] => {
      const recent = this.srv.store.messages(sid).slice(-64);
      const kept: Message[] = [];
      let budget = 64 * 1024;
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i]!;
        if (budget - m.content.length < 0) break;
        budget -= m.content.length;
        kept.unshift(m);
      }
      return kept;
    };
    if (sideId !== undefined && sideId !== "") {
      const sides = this.srv.store.btwSides(this.sess);
      if (!sides.some((x) => x.id === sideId)) {
        this.send({ type: EvError, error: "사이드를 찾을 수 없습니다: " + sideId });
        return;
      }
      target = sideId;
      for (const m of boundTail(sideId)) msgs.push({ role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name });
    } else {
      target = this.srv.store.newBtwSide(this.sess).id;
      for (const m of boundTail(this.sess)) msgs.push({ role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name });
    }
    msgs.push({ role: "user", content: "(사이드 질문, 메인 세션 기록에 반영하지 않음) " + text });

    this.busy = true;
    let answer = "";
    try {
      await agent.llm.streamChat(undefined, msgs, [], (kind, _name, chunk) => {
        if (kind === "reasoning") {
          this.send({ type: EvReasoning, text: chunk });
        } else {
          answer += chunk;
          this.send({ type: EvDelta, text: chunk });
        }
      });
      this.srv.store.appendMessage(target, { role: "user", content: text });
      this.srv.store.appendMessage(target, { role: "assistant", content: answer });
    } catch (err) {
      this.send({ type: EvError, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
    }
    this.send({ type: EvDone });
    this.send({ type: EvStatus, name: "idle" });
  }

  private currentProject(): number {
    if (this.sess === "") return 0;
    try {
      return this.srv.store.session(this.sess).projectId;
    } catch {
      return 0;
    }
  }

  /** pushHistory replays the stored transcript of the current session. */
  private pushHistory(): void {
    const msgs = this.srv.store.messages(this.sess);
    const entries: HistoryEntry[] = [];
    for (const m of msgs) {
      switch (m.role) {
        case "user":
          entries.push({ kind: "user", text: m.content });
          break;
        case "assistant": {
          if (m.content !== "") entries.push({ kind: "assistant", text: m.content });
          for (const tc of m.toolCalls ?? []) {
            let args = tc.args;
            if (args.length > 120) args = args.slice(0, 120) + "…";
            entries.push({ kind: "tool", text: tc.name + " " + args });
          }
          break;
        }
        case "tool":
          entries.push({ kind: "result", text: m.content });
          break;
      }
    }
    this.send({ type: EvHistory, session: this.sess, history: entries });
  }

  private pushSessions(projectID: number): void {
    const list: SessionInfo[] = this.srv.store.sessions(projectID);
    this.send({ type: EvSessions, sessions: list });
  }

  private pushState(): void {
    this.send({ type: EvState, session: this.sess, state: this.srv.panelState(this.sess, this.proj) });
  }
}
