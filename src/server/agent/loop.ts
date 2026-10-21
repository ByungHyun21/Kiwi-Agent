// Runs the server-side agent loop: the LLM↔tool iteration, system prompt
// assembly, and compaction. Tool schemas live in tools.ts and execution in
// execute.ts; the model never learns how tools are executed.

import type { Client, Usage } from "../../llm.ts";
import type { Runner } from "../../ssh.ts";
import {
  EvDelta,
  EvReasoning,
  EvToolArgs,
  EvToolCall,
  EvToolResult,
  EvState,
  type Event,
  type Machine,
  type PanelState,
} from "../../shared/protocol.ts";
import type { Message, Store } from "../../store.ts";
import { ToolExecutor } from "./execute.ts";
import { systemPrompt } from "./prompt.ts";
import { agentTools, READ_ONLY_TOOLS } from "./tools.ts";

/** Agent executes one session's turns against one project folder. */
export class Agent {
  llm: Client;
  runner: Runner;
  machine: Machine;
  workdir: string;
  store: Store;
  emit?: (e: Event) => void;
  private tools: ToolExecutor;

  /** MaxIterations bounds one turn's tool loop. */
  maxIterations = 0;

  constructor(opts: {
    llm: Client;
    runner: Runner;
    machine: Machine;
    workdir: string;
    store: Store;
    emit?: (e: Event) => void;
  }) {
    this.llm = opts.llm;
    this.runner = opts.runner;
    this.machine = opts.machine;
    this.workdir = opts.workdir;
    this.store = opts.store;
    this.emit = opts.emit;
    this.tools = new ToolExecutor({ runner: opts.runner, machine: opts.machine, workdir: opts.workdir, store: opts.store });
  }

  /** Turn runs one user message to completion, streaming raw events via emit. */
  async turn(signal: AbortSignal | undefined, sessionID: string, userText: string): Promise<void> {
    this.store.appendMessage(sessionID, { role: "user", content: userText });
    const maxIter = this.maxIterations > 0 ? this.maxIterations : 12;

    const sys = await this.systemMessage(signal);
    for (let iter = 0; iter < maxIter; iter++) {
      for (const q of this.store.drainQueue(sessionID)) {
        this.store.appendMessage(sessionID, { role: "user", content: q });
      }
      const history = this.store.messages(sessionID);
      const msgs = [{ role: "system", content: sys } as Message];
      for (const m of history) {
        const msg: Message = { role: m.role, content: m.content, toolCallID: m.toolCallID, name: m.name };
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
      });
      this.store.addUsage(sessionID, resp.usage.promptTokens, resp.usage.completionTokens);
      this.emitState(resp.usage);

      const stored: Message = { role: "assistant", content: resp.content };
      if (resp.toolCalls.length > 0) {
        stored.toolCalls = resp.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
      }
      this.store.appendMessage(sessionID, stored);

      if (resp.toolCalls.length === 0) return;
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

  /** systemMessage combines the minimal tool-usage prompt with the project's
   *  AGENTS.md when present. No behavioral instructions are injected. */
  private async systemMessage(signal: AbortSignal | undefined): Promise<string> {
    let sys = systemPrompt;
    const res = await this.runner.run(this.machine, this.workdir, ["read", "AGENTS.md"], null, signal);
    if (res.ok && res.data?.trim()) {
      sys += "\n\n# AGENTS.md\n\n" + res.data;
    }
    return sys;
  }

  private emitEvent(e: Event): void {
    this.emit?.(e);
  }

  private emitState(u: Usage): void {
    const ctxMax = this.settingInt("ctx_max", 128000);
    const state: PanelState = {
      project: "",
      machine: "",
      model: "",
      goal: "",
      ctxUsed: u.promptTokens + u.completionTokens,
      ctxMax,
      tokens: 0,
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
      b += m.role + ": " + m.content + "\n";
    }
    const summary = await this.llm.complete(signal, [
      { role: "system", content: "다음 코딩 세션 기록을, 만들어진 파일과 결정된 사항을 보존하여 간결한 요약으로 만들어 주세요. 요약 본문만 출력하세요." },
      { role: "user", content: b },
    ]);
    this.store.replaceMessages(sessionID, [
      { role: "user", content: "[지금까지 세션 요약]\n" + summary },
    ]);
  }

  /** ShouldCompact reports whether usage crossed the auto-compact threshold. */
  shouldCompact(used: number, max: number): boolean {
    if (max <= 0) return false;
    const threshold = this.settingInt("compact_threshold", 80);
    return (used * 100) / max >= threshold;
  }
}
