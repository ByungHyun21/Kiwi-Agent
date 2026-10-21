// Executes one agent tool call against the work machine. Every tool is a
// structured `kiwi exec` invocation; the model only sees the raw text result.

import type { ToolCall } from "../../llm.ts";
import type { Machine } from "../../shared/protocol.ts";
import type { Runner } from "../../ssh.ts";
import type { Store } from "../../store.ts";
import { unifiedDiff } from "./diff.ts";
import { pathErr, safePath, tokenize } from "./paths.ts";

/** ToolExecutorOptions binds tool calls to one machine folder. */
export interface ToolExecutorOptions {
  runner: Runner;
  machine: Machine;
  workdir: string;
  store: Store;
}

/** ToolExecutor runs agent tool calls as structured remote exec operations. */
export class ToolExecutor {
  private runner: Runner;
  private machine: Machine;
  private workdir: string;
  private store: Store;

  constructor(opts: ToolExecutorOptions) {
    this.runner = opts.runner;
    this.machine = opts.machine;
    this.workdir = opts.workdir;
    this.store = opts.store;
  }

  /** runTool executes one tool call and returns the raw display text. */
  async run(signal: AbortSignal | undefined, sessionID: string, tc: ToolCall): Promise<string> {
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
        return this.write(signal, p, str("content"));
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

  private async write(signal: AbortSignal | undefined, rel: string, content: string): Promise<string> {
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
}
