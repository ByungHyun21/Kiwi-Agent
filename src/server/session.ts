// SessionRuntime owns one session's agent lifecycle: turn execution, queue
// draining, compaction, side questions, and file/path queries. It never
// touches the socket — events go through emit, so a connection can later
// host several runtimes (tabs) or reconnect to an existing one.

import type { Agent } from "./agent/loop.ts";
import { safePath } from "./agent/paths.ts";
import { systemPromptText } from "./agent/prompt.ts";
import { runServerCommand, type ServerCommandContext } from "./commands.ts";
import {
  EvBtwSides,
  EvCat,
  EvDelta,
  EvDone,
  EvError,
  EvHistory,
  EvNotice,
  EvPathComplete,
  EvReasoning,
  EvSessions,
  EvState,
  EvStatus,
  isThinkLevel,
  type Event,
  type HistoryEntry,
  type Machine,
  type PanelState,
  type SessionInfo,
} from "../shared/protocol.ts";
import { parseSlashCommand } from "../shared/slash.ts";
import type { Runner } from "../ssh.ts";
import type { Message, Store } from "../store.ts";

/** SessionHost is the server surface a runtime needs (KiwiServer satisfies it). */
export interface SessionHost {
  store: Store;
  runner: Runner;
  agentFor(sessionID: string): Agent;
  panelState(sessionID: string, projectName: string): PanelState;
  execFor(sessionID: string, projectId: number): { machine: Machine; workdir: string };
}

/** SessionRuntime drives one session on behalf of a connection. */
export class SessionRuntime {
  sess = "";
  projID = 0;
  proj = "";
  busy = false;
  private host: SessionHost;
  private emit: (e: Event) => void;
  private cancel: AbortController | null = null;

  constructor(host: SessionHost, emit: (e: Event) => void) {
    this.host = host;
    this.emit = emit;
  }

  /** shutdown aborts any in-flight turn. */
  shutdown(): void {
    this.cancel?.abort();
  }

  stop(): void {
    this.cancel?.abort();
  }

  selectProject(name: string): void {
    try {
      const p = this.host.store.projectByName(name);
      this.projID = p.id;
      this.proj = p.name;
    } catch {
      // unknown project: keep current
    }
    this.pushState();
    this.pushSessions(this.projID);
  }

  newSession(name: string): void {
    const pID = this.projID;
    if (pID === 0) {
      this.emit({ type: EvError, error: "먼저 프로젝트를 선택하세요 (/project)." });
      return;
    }
    try {
      this.sess = this.host.store.newSession(pID, name).id;
    } catch (err) {
      this.emit({ type: EvError, error: String(err) });
      return;
    }
    this.pushSessions(pID);
    this.pushState();
  }

  resume(id: string): void {
    try {
      const sess = this.host.store.session(id);
      this.sess = sess.id;
      try {
        const p = this.host.store.project(sess.projectId);
        this.projID = p.id;
        this.proj = p.name;
      } catch {
        // project was deleted; keep the session
      }
    } catch {
      this.emit({ type: EvError, error: "세션을 찾을 수 없습니다: " + id });
      return;
    }
    this.pushHistory();
    this.pushState();
    this.pushSessions(this.projID);
  }

  send(text: string): void {
    if (this.sess === "") {
      this.emit({ type: EvError, error: "선택된 세션이 없습니다. /project 또는 /new 로 시작하세요." });
      return;
    }
    const cmd = parseSlashCommand(text);
    if (cmd?.spec) {
      if (cmd.spec.target === "client") {
        this.emit({ type: EvError, error: `/${cmd.name} 명령은 입력창에서 처리됩니다.` });
        return;
      }
      if (runServerCommand(cmd, this.commandContext())) return;
    }
    if (this.busy) {
      this.host.store.enqueue(this.sess, text);
      this.emit({ type: EvStatus, name: "queued" });
      return;
    }
    this.runTurn(text);
  }

  /** setThink persists a session reasoning level and shows a transient notice. */
  setThink(level: string): void {
    if (this.sess === "") {
      this.emit({ type: EvError, error: "선택된 세션이 없습니다." });
      return;
    }
    if (!isThinkLevel(level)) {
      this.emit({ type: EvError, error: "추론 레벨이 올바르지 않습니다." });
      return;
    }
    this.host.store.setSessionThink(this.sess, level);
    this.pushState();
    this.emit({ type: EvNotice, text: `추론 레벨: ${level}` });
  }

  private commandContext(): ServerCommandContext {
    return {
      setThink: (level) => this.setThink(level),
      notice: (text) => this.emit({ type: EvNotice, text }),
      error: (text) => this.emit({ type: EvError, error: text }),
    };
  }

  setGoal(text: string): void {
    if (this.sess === "") return;
    this.host.store.setGoal(this.sess, text);
    this.pushState();
  }

  setWorkdir(dir: string): void {
    if (this.sess === "" || dir === "") return;
    this.host.store.setSessionLocation(this.sess, { workdir: dir });
    this.pushState();
    this.emit({ type: EvStatus, name: "session-moved" });
  }

  setMachine(name: string): void {
    if (this.sess === "" || name === "") return;
    try {
      this.host.store.machine(name);
    } catch {
      this.emit({ type: EvError, error: "등록되지 않은 머신: " + name });
      return;
    }
    this.host.store.setSessionLocation(this.sess, { machine: name });
    this.pushState();
    this.emit({ type: EvStatus, name: "session-host-moved" });
  }

  /** cat streams a file into the viewer without touching agent context. */
  async cat(p: string): Promise<void> {
    if (!safePath(p)) {
      this.emit({ type: EvCat, name: p, result: "", error: "경로는 작업 폴더 안의 상대 경로여야 합니다: " + p });
      return;
    }
    let loc;
    try {
      loc = this.host.execFor(this.sess, this.projID);
    } catch (err) {
      this.emit({ type: EvCat, name: p, result: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const res = await this.host.runner.run(loc.machine, loc.workdir, ["read", p], null, undefined);
    if (!res.ok) this.emit({ type: EvCat, name: p, result: "", error: `오류 (${res.code}): ${res.message}` });
    else this.emit({ type: EvCat, name: p, result: res.data ?? "" });
  }

  /** pathComplete returns ls-based path candidates for tab completion. */
  async pathComplete(partial: string): Promise<void> {
    if (partial.startsWith("/") || partial.includes("..")) {
      this.emit({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const slash = partial.lastIndexOf("/");
    const dir = slash >= 0 ? partial.slice(0, slash + 1) : "";
    const prefix = slash >= 0 ? partial.slice(slash + 1) : partial;
    let loc;
    try {
      loc = this.host.execFor(this.sess, this.projID);
    } catch {
      this.emit({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const res = await this.host.runner.run(loc.machine, loc.workdir, dir === "" ? ["ls"] : ["ls", dir], null, undefined);
    if (!res.ok) {
      this.emit({ type: EvPathComplete, text: partial, candidates: [] });
      return;
    }
    const candidates = (res.data ?? "").split("\n").filter((n) => n !== "" && n.startsWith(prefix)).slice(0, 20).map((n) => dir + n);
    this.emit({ type: EvPathComplete, text: partial, candidates });
  }

  /** runTurn executes one agent turn, auto-compacts if needed, drains the queue. */
  runTurn(text: string): void {
    void this._runTurn(text);
  }

  private async _runTurn(text: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.host.agentFor(this.sess);
    } catch (err) {
      this.emit({ type: EvError, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let lastState: PanelState | undefined;
    agent.emit = (e: Event) => {
      if (e.state) lastState = e.state;
      if (e.type === EvState && e.state) {
        // agent state carries only ctx values; merge in panel identity
        const merged: PanelState = {
          ...this.host.panelState(this.sess, this.proj),
          ctxUsed: e.state.ctxUsed,
          ctxMax: e.state.ctxMax,
        };
        this.emit({ ...e, state: merged });
        return;
      }
      this.emit(e);
    };

    this.busy = true;
    const ac = new AbortController();
    this.cancel = ac;
    this.emit({ type: EvStatus, name: "working" });
    try {
      // drain loop: one turn, then any prompts queued while busy
      for (;;) {
        try {
          await agent.turn(ac.signal, this.sess, text);
        } catch (err) {
          if (!ac.signal.aborted) {
            this.emit({ type: EvError, error: err instanceof Error ? err.message : String(err) });
          } else {
            this.emit({ type: EvStatus, name: "stopped" });
          }
        }
        if (lastState && agent.shouldCompact(lastState.ctxUsed, lastState.ctxMax)) {
          try {
            await agent.compact(undefined, this.sess);
            this.emit({ type: EvStatus, name: "compacted" });
          } catch {
            // compaction failures are non-fatal
          }
        }
        this.emit({ type: EvDone });
        this.emit({ type: EvStatus, name: "idle" });
        this.pushSessions(this.currentProject());

        const next = this.host.store.dequeue(this.sess);
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

  async compact(): Promise<void> {
    if (this.sess === "" || this.busy) return;
    let agent: Agent;
    try {
      agent = this.host.agentFor(this.sess);
    } catch (err) {
      this.emit({ type: EvError, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    agent.emit = (e) => this.emit(e);
    this.busy = true;
    try {
      await agent.compact(undefined, this.sess);
      this.emit({ type: EvStatus, name: "compacted" });
      this.pushState();
    } catch (err) {
      this.emit({ type: EvError, error: "compact 실패: " + (err instanceof Error ? err.message : String(err)) });
    } finally {
      this.busy = false;
    }
  }

  async btw(text: string, sideId?: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.host.agentFor(this.sess);
    } catch {
      return;
    }
    let target = "";
    const msgs: Message[] = [{ role: "system", content: systemPromptText() }];
    const boundTail = (sid: string): Message[] => {
      const recent = this.host.store.messages(sid).slice(-64);
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
      const sides = this.host.store.btwSides(this.sess);
      if (!sides.some((x) => x.id === sideId)) {
        this.emit({ type: EvError, error: "사이드를 찾을 수 없습니다: " + sideId });
        return;
      }
      target = sideId;
      for (const m of boundTail(sideId)) msgs.push({ role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name });
    } else {
      target = this.host.store.newBtwSide(this.sess).id;
      for (const m of boundTail(this.sess)) msgs.push({ role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name });
    }
    msgs.push({ role: "user", content: "(사이드 질문, 메인 세션 기록에 반영하지 않음) " + text });

    this.busy = true;
    let answer = "";
    try {
      await agent.llm.streamChat(undefined, msgs, [], (kind, _name, chunk) => {
        if (kind === "reasoning") {
          this.emit({ type: EvReasoning, text: chunk });
        } else {
          answer += chunk;
          this.emit({ type: EvDelta, text: chunk });
        }
      }, { think: agent.think });
      this.host.store.appendMessage(target, { role: "user", content: text });
      this.host.store.appendMessage(target, { role: "assistant", content: answer });
    } catch (err) {
      this.emit({ type: EvError, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
    }
    this.emit({ type: EvDone });
    this.emit({ type: EvStatus, name: "idle" });
  }

  /** pushSides emits the retained BTW sides of the current session. */
  pushSides(): void {
    this.emit({ type: EvBtwSides, sessions: this.host.store.btwSides(this.sess) });
  }

  /** pushHistory replays the stored transcript of the current session. */
  pushHistory(): void {
    const msgs = this.host.store.messages(this.sess);
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
    this.emit({ type: EvHistory, session: this.sess, history: entries });
  }

  pushSessions(projectID: number = this.currentProject()): void {
    const list: SessionInfo[] = this.host.store.sessions(projectID);
    this.emit({ type: EvSessions, sessions: list });
  }

  pushState(): void {
    this.emit({ type: EvState, session: this.sess, state: this.host.panelState(this.sess, this.proj) });
  }

  private currentProject(): number {
    if (this.sess === "") return 0;
    try {
      return this.host.store.session(this.sess).projectId;
    } catch {
      return 0;
    }
  }
}
