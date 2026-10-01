// The agent WebSocket endpoint: one TUI connection with its session runtime.

import {
  EvDelta,
  EvDone,
  EvError,
  EvHello,
  EvHistory,
  EvReasoning,
  EvSessions,
  EvState,
  EvStatus,
  HistoryEntry,
  MsgBtw,
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
import { Agent, systemPromptText } from "../agent.ts";
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
        this.runBtw(msg.text ?? "");
        return;
    }
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

  private async runBtw(text: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.srv.agentFor(this.sess);
    } catch {
      return;
    }
    const history = this.srv.store.messages(this.sess);
    const msgs = [{ role: "system", content: systemPromptText() } as Message];
    for (const m of history) {
      msgs.push({ role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name });
    }
    msgs.push({ role: "user", content: "(사이드 질문, 세션 기록에 반영하지 않음) " + text });

    this.busy = true;
    try {
      await agent.llm.streamChat(undefined, msgs, [], (kind, _name, chunk) => {
        if (kind === "reasoning") {
          this.send({ type: EvReasoning, text: chunk });
        } else {
          this.send({ type: EvDelta, text: chunk });
        }
      });
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
