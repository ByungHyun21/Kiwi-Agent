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
        const outs = await Promise.all(calls.map((tc) => this.runTool(signal, sessionID, tc)));
        results.push(...outs);
      } else {
        for (const tc of calls) {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          results.push(await this.runTool(signal, sessionID, tc));
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

  /** runTool executes one tool call and returns the raw display text. */
  private async runTool(signal: AbortSignal | undefined, sessionID: string, tc: ToolCall): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.args || "{}") as Record<string, unknown>;
    } catch (err) {
      return "오류: 도구 인자가 잘못되었습니다: " + String(err);
    }
    const str = (k: string, def = ""): string => (typeof args[k] === "string" ? (args[k] as string) : def);
    const int = (k: string): number | null => {
      const n = typeof args[k] === "number" ? (args[k] as number) : parseInt(String(args[k] ?? ""), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const p = str("path");

    switch (tc.name) {
      case "write_file": {
        if (!safePath(p)) return pathErr(p);
        return this.toolWrite(signal, p, str("content"));
      }
      case "read_file": {
        if (!safePath(p)) return pathErr(p);
        const res = await this.runner.run(this.machine, this.workdir, ["read", ...(args.tagged === true ? ["--tag"] : []), p], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "edit": {
        if (!safePath(p)) return pathErr(p);
        const old = await this.runner.run(this.machine, this.workdir, ["read", p], null, signal);
        const oldText = old.ok ? old.data ?? "" : "";
        let payload: { edits?: { oldText: string; newText: string }[]; lineEdits?: { pos: string; op: string; newText?: string }[] };
        if (Array.isArray(args.lineEdits)) {
          const raw = args.lineEdits as { pos?: unknown; op?: unknown; newText?: unknown }[];
          payload = { lineEdits: raw.map((e) => ({ pos: String(e.pos ?? ""), op: String(e.op ?? "replace"), ...(e.newText === undefined ? {} : { newText: String(e.newText) }) })) };
          if (payload.lineEdits!.length === 0) return "오류: lineEdits 배열이 비어 있습니다";
        } else {
          const rawEdits = Array.isArray(args.edits) ? (args.edits as { oldText?: unknown; newText?: unknown }[]) : [];
          const edits = rawEdits.map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }));
          if (edits.length === 0) return "오류: edits 배열이 비어 있습니다";
          payload = { edits };
        }
        const res = await this.runner.run(this.machine, this.workdir, ["edit", p], new TextEncoder().encode(JSON.stringify(payload)), signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        let newText = "";
        try {
          newText = ((JSON.parse(res.data ?? "{}") as { content?: string }).content) ?? "";
        } catch {
          // fall through with empty content
        }
        if (oldText === "") return unifiedDiff(p, "", newText);
        return p + " 수정됨\n" + unifiedDiff(p, oldText, newText);
      }
      case "list_dir": {
        const argv = p ? ["ls", p] : ["ls"];
        const res = await this.runner.run(this.machine, this.workdir, argv, null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "grep": {
        const pattern = str("pattern");
        if (pattern === "") return "오류: pattern이 비어 있습니다";
        const argv = ["grep", pattern];
        const include = str("include");
        if (include !== "") argv.push("--include", include);
        argv.push(p !== "" && safePath(p) ? p : ".");
        const res = await this.runner.run(this.machine, this.workdir, argv, null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "glob": {
        const pattern = str("pattern");
        if (pattern === "") return "오류: pattern이 비어 있습니다";
        const res = await this.runner.run(this.machine, this.workdir, ["glob", pattern, p !== "" && safePath(p) ? p : "."], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "monitor_start": {
        const argv = tokenize(str("command"));
        if (argv.length === 0) return "오류: command가 비어 있습니다";
        const label = str("label");
        const res = await this.runner.run(this.machine, this.workdir, ["mon", "start", ...(label !== "" ? ["--label", label] : []), ...argv], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "monitor_output": {
        const id = str("id");
        if (id === "") return "오류: id가 비어 있습니다";
        const res = await this.runner.run(this.machine, this.workdir, ["mon", "out", id], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "monitor_stop": {
        const id = str("id");
        if (id === "") return "오류: id가 비어 있습니다";
        const res = await this.runner.run(this.machine, this.workdir, ["mon", "stop", id], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "monitor_list": {
        const res = await this.runner.run(this.machine, this.workdir, ["mon", "list"], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "lsp_status": {
        const res = await this.runner.run(this.machine, this.workdir, ["lsp", "status", str("lang") || "typescript"], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "lsp_diagnostics": {
        if (!safePath(p)) return pathErr(p);
        const res = await this.runner.run(this.machine, this.workdir, ["lsp", "diagnostics", p], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "lsp_definition":
      case "lsp_references": {
        if (!safePath(p)) return pathErr(p);
        const line = int("line");
        const character = int("character");
        if (!line || !character) return "오류: line과 character(1-based)가 필요합니다";
        const sub = tc.name === "lsp_definition" ? "definition" : "references";
        const res = await this.runner.run(this.machine, this.workdir, ["lsp", sub, p, String(line), String(character)], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "lsp_symbols": {
        if (!safePath(p)) return pathErr(p);
        const res = await this.runner.run(this.machine, this.workdir, ["lsp", "symbols", p], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}`;
        return res.data ?? "";
      }
      case "run": {
        const argv = tokenize(str("command"));
        if (argv.length === 0) return "오류: command가 비어 있습니다";
        const timeoutMs = int("timeoutMs");
        const res = await this.runner.run(this.machine, this.workdir,
          ["run", ...(timeoutMs ? ["--timeout", String(Math.min(timeoutMs, 600_000))] : []), ...argv], null, signal);
        if (!res.ok) return `오류 (${res.code}): ${res.message}\n${res.data ?? ""}`;
        return res.data ?? "";
      }
      case "session_search": {
        const rows = this.store.searchMessages(str("query"), int("limit") ?? 10);
        if (rows.length === 0) return "(검색 결과 없음)";
        return rows.map((r) => `${r.sessionId} [${r.role}] ${r.snippet.replaceAll("\n", " ")}`).join("\n");
      }
      case "session_read": {
        const sid = str("sessionId") || sessionID;
        let msgs;
        try {
          msgs = this.store.messages(sid);
        } catch {
          return "오류: 세션을 찾을 수 없습니다: " + sid;
        }
        const tail = msgs.slice(-(int("limit") ?? 20));
        if (tail.length === 0) return "(메시지 없음)";
        return tail.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n");
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

const systemPrompt = `당신은 코딩 에이전트입니다. 도구로 작업 폴더의 파일을 만들고, 읽고, 수정하고, 검색하고, 셸 명령을 실행합니다. 파일 경로는 작업 폴더 기준 상대 경로입니다.
- 파일 일부 수정은 edit을 사용하세요 (전체 재작성 금지). oldText는 파일 내에 정확히 한 번 나타나야 합니다.
- 코드 내용 검색은 grep, 파일명 검색은 glob을 사용하세요.
- 빌드·테스트·실행은 run을 사용하세요 (command는 따옴표로 인자를 구분하는 명령 문자열).
- 서로 의존하지 않는 읽기(read_file, list_dir, grep, glob, session_search, session_read)는 한 응답에 여러 개 함께 호출하면 병렬로 실행됩니다.
- 과거 세션 기록은 session_search로 검색하고 session_read로 읽을 수 있습니다.
- read_file에 tagged:true를 주면 각 줄이 "N#TAG│ 내용" 형태로 옵니다. 정밀 줄 수정은 edit의 lineEdits([{pos:"N#TAG", op:"replace"|"insertBefore"|"insertAfter"|"delete", newText}])로 하세요 — 읽은 뒤 줄이 바뀌었으면 거부(stale)됩니다.
- 오래 걸리는 명령(서버 기동, 로그 감시)은 monitor_start로 시작하고 monitor_output으로 새 출력을 받아오고(아직 running이면 잠시 후 다시) monitor_stop으로 중지합니다. monitor_list로 목록을 봅니다.
- 코드 오류 확인은 lsp_diagnostics, 정의/참조는 lsp_definition/lsp_references(line·character 1-based), 심볼 목록은 lsp_symbols를 사용하세요(작업 머신의 언어서버가 기동됩니다).`;

/** SystemPrompt exposes the agent system prompt (used by side channels). */
export function systemPromptText(): string {
  return systemPrompt;
}

const agentTools: Tool[] = [
  {
    name: "write_file",
    description: "작업 폴더에 파일을 생성하거나 전체 내용을 덮어씁니다. 새 파일이나 전체 재작성 시에만 사용하세요.",
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
    description: "작업 폴더의 파일 내용을 읽습니다. tagged:true면 줄마다 N#TAG│ 접두가 붙습니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        tagged: { type: "boolean", description: "줄 태그 포함(정밀 줄 편집용)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description: "파일의 일부를 문자열 치환으로 수정합니다. 각 oldText는 파일에서 정확히 한 번 나타나야 합니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로" },
        lineEdits: {
          type: "array",
          description: "pos 태그 기반 줄 편집(read_file tagged:true의 N#TAG 사용). edits 대신 사용",
          items: {
            type: "object",
            properties: {
              pos: { type: "string", description: "예: 12#ABC" },
              op: { type: "string", description: "replace | insertBefore | insertAfter | delete" },
              newText: { type: "string" },
            },
            required: ["pos"],
          },
        },
        edits: {
          type: "array",
          description: "순서대로 적용할 치환 목록",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "파일에서 찾을 유일한 텍스트" },
              newText: { type: "string", description: "새 텍스트" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
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
  {
    name: "grep",
    description: "정규식으로 파일 내용을 검색합니다(rg 우선, grep 폴백). 결과는 파일:줄:내용 형식입니다.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "검색 패턴" },
        include: { type: "string", description: "파일명 글롭 필터, 예: *.ts" },
        path: { type: "string", description: "기본값: 작업 폴더 전체" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "파일명 패턴(예: **/*.py)으로 파일을 찾습니다. 최근 수정 순으로 최대 100건.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "기본값: 작업 폴더 루트" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "lsp_status",
    description: "LSP 데몬(작업 머신의 언어서버) 상태를 조회합니다.",
    parameters: {
      type: "object",
      properties: {
        lang: { type: "string", description: "기본값: typescript" },
      },
    },
  },
  {
    name: "lsp_diagnostics",
    description: "파일의 컴파일/정적 오류를 언어서버 진단으로 조회합니다(ts/py/go/rust/c/cpp/cs/java/js). 첫 호출은 서버 기동에 수 초~수십 초 걸릴 수 있습니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로" },
      },
      required: ["path"],
    },
  },
  {
    name: "lsp_definition",
    description: "심볼의 정의 위치로 이동 정보를 얻습니다. line/character는 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_references",
    description: "심볼의 모든 참조 위치를 조회합니다. line/character는 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_symbols",
    description: "파일의 심볼 목록(이름·종류·줄)을 조회합니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "monitor_start",
    description: "셸 명령을 백그라운드에서 시작하고 감시합니다(서버 기동, 로그 감시 등). 즉시 monitor id를 반환합니다.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "예: python3 -m http.server 8000" },
        label: { type: "string", description: "선택: 표시 이름" },
      },
      required: ["command"],
    },
  },
  {
    name: "monitor_output",
    description: "감시 중인 명령의 새 출력을 받아옵니다. running:true면 아직 진행 중이니 적절히 다시 호출하세요.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "monitor_stop",
    description: "감시 중인 명령을 중지합니다.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "monitor_list",
    description: "모니터 목록(id, 라벨, 실행 여부, 출력 바이트)을 반환합니다.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run",
    description: "작업 폴더에서 셸 명령을 실행합니다(빌드, 테스트, 실행 등). 명령은 직접 실행되며 경로 이동 없이 작업 폴더에서 시작됩니다.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "예: python3 gugudan.py" },
        timeoutMs: { type: "number", description: "선택: 시간 제한(ms, 최대 600000). 기본 120000" },
      },
      required: ["command"],
    },
  },
  {
    name: "session_search",
    description: "과거 세션을 포함한 모든 대화 기록을 전문 검색합니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "기본 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "session_read",
    description: "세션 대화 기록을 읽습니다. sessionId 생략 시 현재 세션의 최근 메시지를 반환합니다.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "기본값: 현재 세션" },
        limit: { type: "number", description: "끝에서부터의 메시지 수, 기본 20" },
      },
    },
  },
];

const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "grep", "glob", "session_search", "session_read", "monitor_output", "monitor_list", "lsp_status", "lsp_diagnostics", "lsp_definition", "lsp_references", "lsp_symbols"]);

function pathErr(p: string): string {
  return "오류: 경로는 작업 폴더 안의 상대 경로여야 합니다: " + p;
}

/** tokenize splits a shell-like command string into argv, honoring quotes. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (cur !== "" || has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
  }
  if (cur !== "" || has) out.push(cur);
  return out;
}

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
