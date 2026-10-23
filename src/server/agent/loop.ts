// Runs the server-side agent loop: the LLM↔tool iteration, system prompt
// assembly, and compaction. Tool schemas live in tools.ts and execution in
// execute.ts; the model never learns how tools are executed.

import { createHash } from "node:crypto";
import type { Client } from "../../llm.ts";
import type { Runner } from "../../ssh.ts";
import {
  EvDelta,
  EvNotice,
  EvReasoning,
  EvToolArgs,
  EvToolCall,
  EvToolResult,
  EvState,
  type Event,
  type Machine,
  type PanelState,
  type ThinkLevel,
} from "../../shared/protocol.ts";
import type { Message, Store } from "../../store.ts";
import { unifiedDiff } from "./diff.ts";
import { ToolExecutor } from "./execute.ts";
import { systemPrompt } from "./prompt.ts";
import { agentTools, READ_ONLY_TOOLS } from "./tools.ts";

const SYSTEM_PROMPT_VERSION = createHash("sha256")
  .update(systemPrompt)
  .update(JSON.stringify(agentTools))
  .digest("hex")
  .slice(0, 16);
const DEFAULT_CONTEXT_REFRESH_HOURS = 6;

/** Agent executes one session's turns against one project folder. */
export class Agent {
  llm: Client;
  runner: Runner;
  machine: Machine;
  workdir: string;
  store: Store;
  think: ThinkLevel;
  emit?: (e: Event) => void;
  private tools: ToolExecutor;
  private ctxMax = 0;

  /** MaxIterations bounds one turn's tool loop. */
  maxIterations = 0;

  constructor(opts: {
    llm: Client;
    runner: Runner;
    machine: Machine;
    workdir: string;
    store: Store;
    searxngUrl?: string;
    think?: ThinkLevel;
    emit?: (e: Event) => void;
  }) {
    this.llm = opts.llm;
    this.runner = opts.runner;
    this.machine = opts.machine;
    this.workdir = opts.workdir;
    this.store = opts.store;
    this.think = opts.think ?? "auto";
    this.emit = opts.emit;
    this.tools = new ToolExecutor({
      runner: opts.runner,
      machine: opts.machine,
      workdir: opts.workdir,
      store: opts.store,
      searxngUrl: opts.searxngUrl,
    });
  }

  /** Turn runs one user message to completion, streaming raw events via emit. */
  async turn(signal: AbortSignal | undefined, sessionID: string, userText: string): Promise<void> {
    const maxIter = this.maxIterations > 0 ? this.maxIterations : 12;
    if (this.ctxMax <= 0) {
      this.ctxMax = (await this.llm.modelContextLength(signal)) || this.settingInt("ctx_max", 128000);
    }

    // Resolve the stable prefix before opening the new user turn. An AGENTS.md
    // change appends a hidden context message instead of rewriting the prefix.
    const sys = await this.ensureSystem(sessionID, signal);
    this.store.appendMessage(sessionID, { role: "user", content: userText });
    for (let iter = 0; iter < maxIter; iter++) {
      for (const q of this.store.drainQueue(sessionID)) {
        this.store.appendMessage(sessionID, { role: "user", content: q });
      }
      const history = this.store.messages(sessionID);
      // Only replay reasoning produced after the most recent user message.
      // This keeps the current tool loop coherent while dropping older turns.
      let lastUserSeq = -1;
      for (const m of history) {
        if (m.role === "user" && m.seq !== undefined) lastUserSeq = Math.max(lastUserSeq, m.seq);
      }
      const msgs = [{ role: "system", content: sys } as Message];
      for (const m of history) {
        const msg: Message = { role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name };
        if (m.role === "assistant" && (m.seq ?? -1) > lastUserSeq) {
          msg.reasoning = m.reasoning;
        }
        if (m.toolCalls) {
          msg.toolCalls = m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
        }
        msgs.push(msg);
      }

      const resp = await this.llm.streamChat(signal, msgs, agentTools, (kind, name, text) => {
        if (kind === "reasoning") {
          this.emitEvent({ type: EvReasoning, text });
        } else if (kind === "tool_args") {
          this.emitEvent({ type: EvToolArgs, name, text });
        } else {
          this.emitEvent({ type: EvDelta, text });
        }
      }, { think: this.think });
      const ctxUsed = resp.usage.promptTokens + resp.usage.completionTokens;
      if (ctxUsed > 0) this.store.setContextTokens(sessionID, ctxUsed);
      this.emitState(ctxUsed);

      const stored: Message = { role: "assistant", content: resp.content };
      if (resp.reasoning !== "") stored.reasoning = resp.reasoning;
      if (resp.providerMeta) stored.providerMeta = resp.providerMeta;
      if (resp.toolCalls.length > 0) {
        stored.toolCalls = resp.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
      }
      this.store.appendMessage(sessionID, stored);

      if (resp.toolCalls.length === 0) {
        this.store.setLastOutputAt(sessionID, Math.floor(Date.now() / 1000));
        return;
      }
      const calls = resp.toolCalls;
      for (const tc of calls) {
        if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        this.emitEvent({ type: EvToolCall, name: tc.name, args: tc.args });
      }
      const parallelizable = calls.length > 1 && calls.every((tc) => READ_ONLY_TOOLS.has(tc.name));
      const results: string[] = [];
      if (parallelizable) {
        const outs = await Promise.all(calls.map((tc) => this.tools.run(signal, sessionID, tc)));
        results.push(...outs);
      } else {
        for (const tc of calls) {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          results.push(await this.tools.run(signal, sessionID, tc));
        }
      }
      calls.forEach((tc, i) => {
        this.emitEvent({ type: EvToolResult, name: tc.name, result: results[i]! });
        this.store.appendMessage(sessionID, {
          role: "tool", content: results[i]!, toolCallID: tc.id, name: tc.name,
        });
      });
    }
    throw new Error(`최대 도구 반복 횟수(${maxIter}) 초과`);
  }

  /** ensureSystem returns the session's stable system prefix. Full reloads
   *  happen only at session start, compaction, version changes, and idle
   *  boundaries; active AGENTS.md changes append a hidden diff instead. */
  private async ensureSystem(sessionID: string, signal: AbortSignal | undefined): Promise<string> {
    const sess = this.store.session(sessionID);
    const idleHours = this.settingInt("context_refresh_idle_hours", DEFAULT_CONTEXT_REFRESH_HOURS);
    const idle = sess.lastOutputAt > 0
      && Date.now() / 1000 - sess.lastOutputAt >= idleHours * 3600;
    const versionChanged = sess.systemVersion !== SYSTEM_PROMPT_VERSION;

    if (sess.systemText === "" || versionChanged || idle) {
      const agents = await this.readAgents(signal);
      const agentsText = agents.ok ? agents.text : sess.agentsText;
      const systemText = this.buildSystem(agentsText);
      if (sess.systemText !== "") this.store.deleteHiddenMessages(sessionID);
      this.store.setSessionContext(sessionID, systemText, SYSTEM_PROMPT_VERSION, agentsText);
      return systemText;
    }

    const agents = await this.readAgents(signal);
    if (agents.ok && agents.text !== sess.agentsText) {
      const diff = unifiedDiff("AGENTS.md", sess.agentsText, agents.text);
      this.store.appendMessage(sessionID, {
        role: "user",
        content: this.agentsUpdateMessage(diff),
        hidden: true,
      });
      this.store.setSessionContext(sessionID, sess.systemText, sess.systemVersion, agents.text);
      this.emitEvent({ type: EvNotice, text: "AGENTS.md 변경분을 세션 컨텍스트에 추가했습니다." });
    }
    return sess.systemText;
  }

  private buildSystem(agentsText: string): string {
    return agentsText.trim() === ""
      ? systemPrompt
      : systemPrompt + "\n\n# AGENTS.md\n\n" + agentsText;
  }

  private async readAgents(signal: AbortSignal | undefined): Promise<{ ok: boolean; text: string }> {
    const res = await this.runner.run(this.machine, this.workdir, ["read", "AGENTS.md"], null, signal);
    if (res.ok) return { ok: true, text: res.data ?? "" };
    if (res.code === "noent") return { ok: true, text: "" };
    return { ok: false, text: "" };
  }

  private agentsUpdateMessage(diff: string): string {
    return [
      "[AGENTS.md 변경 감지]",
      "현재 세션의 system에는 이전 AGENTS.md 스냅샷이 들어 있습니다.",
      "아래 변경분을 이전 지침에 적용하고, 충돌하는 경우 이 변경을 우선하세요.",
      "",
      "```diff",
      diff,
      "```",
    ].join("\n");
  }

  private emitEvent(e: Event): void {
    this.emit?.(e);
  }

  private emitState(ctxUsed: number): void {
    const state: PanelState = {
      project: "",
      machine: "",
      model: "",
      goal: "",
      ctxUsed,
      ctxMax: this.ctxMax,
      think: this.think,
      workdir: this.workdir,
    };
    this.emitEvent({ type: EvState, state });
  }

  private settingInt(key: string, def: number): number {
    const v = this.store.setting(key);
    if (!v) return def;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return n;
  }

  /** Compact summarizes the session history into a single message. */
  async compact(signal: AbortSignal | undefined, sessionID: string): Promise<void> {
    const history = this.store.messages(sessionID);
    if (history.length === 0) return;
    let b = "";
    for (const m of history) {
      if (m.hidden) continue;
      b += m.role + ": " + m.content + "\n";
    }
    const summary = await this.llm.complete(signal, [
      { role: "system", content: "다음 코딩 세션 기록을, 만들어진 파일과 결정된 사항을 보존하여 간결한 요약으로 만들어 주세요. 요약 본문만 출력하세요." },
      { role: "user", content: b },
    ]);
    this.store.replaceMessages(sessionID, [
      { role: "user", content: "[지금까지 세션 요약]\n" + summary },
    ]);
    this.store.setContextTokens(sessionID, 0);

    // The replacement already invalidated the old prefix. Use this boundary
    // to rebuild the full system snapshot with the latest AGENTS.md.
    const agents = await this.readAgents(signal);
    const agentsText = agents.ok ? agents.text : this.store.session(sessionID).agentsText;
    this.store.setSessionContext(
      sessionID,
      this.buildSystem(agentsText),
      SYSTEM_PROMPT_VERSION,
      agentsText,
    );
  }

  /** ShouldCompact reports whether usage crossed the auto-compact threshold. */
  shouldCompact(used: number, max: number): boolean {
    if (max <= 0) return false;
    const threshold = this.settingInt("compact_threshold", 80);
    return (used * 100) / max >= threshold;
  }
}
