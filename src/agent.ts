// Runs the server-side agent loop: system prompt, tool definitions, the
// LLM↔tool iteration, and compaction. The LLM never learns how tools are
// executed — it only sees file operations in a working folder.

import * as path from "node:path";
import type { Runner } from "./ssh.ts";
import type { Client, ToolCall, Tool, Usage } from "./llm.ts";
import { EvDelta, EvReasoning, EvToolArgs, EvToolCall, EvToolResult, EvState, type Event, type PanelState } from "./protocol.ts";
import type { Message, Store } from "./store.ts";

/** Agent executes one session's turns against one project folder. */
export class Agent {
  llm: Client;
  runner: Runner;
  machine: { name: string; user: string; host: string; port: number; execPath?: string; hostKey?: string; state: string };
  workdir: string;
  store: Store;
  emit?: (e: Event) => void;

  /** MaxIterations bounds one turn's tool loop. */
  maxIterations = 0;

  constructor(opts: {
    llm: Client;
    runner: Runner;
    machine: Agent["machine"];
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
  }

  /** Turn runs one user message to completion, streaming raw events via emit. */
  async turn(signal: AbortSignal | undefined, sessionID: string, userText: string): Promise<void> {
    this.store.appendMessage(sessionID, { role: "user", content: userText });
    const maxIter = this.maxIterations > 0 ? this.maxIterations : 12;

    const sys = await this.systemMessage(signal);
    for (let iter = 0; iter < maxIter; iter++) {
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
      for (const tc of resp.toolCalls) {
        if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        this.emitEvent({ type: EvToolCall, name: tc.name, args: tc.args });
        const result = await this.runTool(signal, tc);
        this.emitEvent({ type: EvToolResult, name: tc.name, result });
        this.store.appendMessage(sessionID, {
          role: "tool", content: result, toolCallID: tc.id, name: tc.name,
        });
      }
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

  /** runTool executes one tool call and returns the raw display text. */
  private async runTool(signal: AbortSignal | undefined, tc: ToolCall): Promise<string> {
    let args: { path?: string; content?: string };
    try {
      args = JSON.parse(tc.args || "{}");
    } catch (err) {
      return "오류: 도구 인자가 잘못되었습니다: " + String(err);
    }
    const p = args.path ?? "";
    if (!safePath(p)) {
      return "오류: 경로는 작업 폴더 안의 상대 경로여야 합니다: " + p;
    }

    switch (tc.name) {
      case "write_file":
        return this.toolWrite(signal, p, args.content ?? "");
      case "read_file": {
        const res = await this.runner.run(this.machine, this.workdir, ["read", p], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "list_dir": {
        const argv = p ? ["ls", p] : ["ls"];
        const res = await this.runner.run(this.machine, this.workdir, argv, null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      default:
        return "오류: 알 수 없는 도구: " + tc.name;
    }
  }

  private async toolWrite(signal: AbortSignal | undefined, rel: string, content: string): Promise<string> {
    const old = await this.runner.run(this.machine, this.workdir, ["read", rel], null, signal);
    const oldText = old.ok ? old.data ?? "" : "";
    const res = await this.runner.run(this.machine, this.workdir, ["write", rel], new TextEncoder().encode(content), signal);
    if (!res.ok) return `오류 (${res.code}): ${res.message}`;
    if (oldText === "") {
      // new file: the diff IS the full raw content
      return unifiedDiff(rel, "", content);
    }
    return rel + " 수정됨\n" + unifiedDiff(rel, oldText, content);
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

const systemPrompt = `당신은 코딩 에이전트입니다. 도구로 작업 폴더의 파일을 만들고, 읽고, 목록합니다. 파일 경로는 작업 폴더 기준 상대 경로입니다.`;

/** SystemPrompt exposes the agent system prompt (used by side channels). */
export function systemPromptText(): string {
  return systemPrompt;
}

const agentTools: Tool[] = [
  {
    name: "write_file",
    description: "작업 폴더에 파일을 생성하거나 전체 내용을 덮어씁니다. 상대 경로를 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로, 예: index.html" },
        content: { type: "string", description: "파일의 전체 새 내용" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "작업 폴더의 파일 내용을 읽습니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "작업 폴더(또는 하위 폴더)의 항목 목록을 봅니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "기본값: 작업 폴더 루트" },
      },
    },
  },
];

/** safePath rejects absolute paths and traversal outside the workdir. */
export function safePath(p: string): boolean {
  if (p === "" || p.startsWith("/")) return false;
  const clean = path.posix.normalize(p);
  return clean !== ".." && !clean.startsWith("../");
}

/** unifiedDiff renders a line diff between old and new content. */
export function unifiedDiff(name: string, oldText: string, newText: string): string {
  const a = oldText.replace(/\n$/, "").split("\n");
  const b = newText.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  for (const ln of lcsDiff(a, b)) {
    if (ln.op === "-") out.push("- " + ln.text);
    else if (ln.op === "+") out.push("+ " + ln.text);
  }
  if (out.length === 0) return name + " 변경 없음";
  return `--- ${name}\n+++ ${name}\n` + out.join("\n");
}

interface DiffLine {
  op: "-" | "+" | " ";
  text: string;
}

/** lcsDiff computes a line-level diff via LCS dynamic programming. */
export function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      else lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++; j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: a[i++]! });
    } else {
      out.push({ op: "+", text: b[j++]! });
    }
  }
  for (; i < n; i++) out.push({ op: "-", text: a[i]! });
  for (; j < m; j++) out.push({ op: "+", text: b[j]! });
  return out;
}
