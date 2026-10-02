// kiwi exec subcommands: structured JSON file operations executed on work
// machines over SSH. Always prints exactly one ExecResult JSON on stdout.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "./updater.ts";
import type { ExecResult } from "./protocol.ts";
import { ensureLspDaemon, langForFile, lspCall, runLspDaemon } from "./lspbroker.ts";

/** Version is reported by the info command. */
export const Version = VERSION;

/** Run executes one kiwi exec subcommand. argv excludes the leading "exec".
 *  Always prints exactly one ExecResult JSON on stdout; returns the exit code. */
export async function run(argv: string[], stdin: ReadableStream<Uint8Array> | null, stdout: typeof process.stdout): Promise<number> {
  let res: ExecResult = { ok: false, code: "error", message: "unreachable" };
  if (argv.length === 0) {
    res = fail("badrequest", "usage: kiwi exec <read|write|edit|ls|grep|glob|run|mon|lsp|info> [args]");
  } else if (argv[0] === "lsp-serve") {
    const lang = argv[argv.indexOf("--lang") + 1] ?? "";
    const root = argv[argv.indexOf("--root") + 1] ?? process.cwd();
    if (lang === "") {
      res = fail("badrequest", "lsp-serve requires --lang");
    } else {
      runLspDaemon({ lang, root: path.resolve(root) });
      await new Promise(() => {});
    }
  } else {
    res = await dispatch(argv, stdin);
  }
  try {
    stdout.write(JSON.stringify(res) + "\n");
  } catch (err) {
    process.stderr.write(`kiwi exec: ${err}\n`);
    return 2;
  }
  return res.ok ? 0 : 1;
}

async function dispatch(argv: string[], stdin: ReadableStream<Uint8Array> | null): Promise<ExecResult> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "read":
      return cmdRead(rest);
    case "mon":
      return cmdMon(rest);
    case "lsp":
      return cmdLsp(rest);
    case "write":
      return cmdWrite(rest, stdin);
    case "edit":
      return cmdEdit(rest, stdin);
    case "ls":
      return cmdLs(rest);
    case "grep":
      return cmdGrep(rest);
    case "glob":
      return cmdGlob(rest);
    case "run":
      return cmdRun(rest);
    case "info":
      return cmdInfo();
    default:
      return fail("badrequest", "unknown command: " + cmd);
  }
}

function cmdRead(argv: string[]): ExecResult {
  const args = [...argv];
  let tagged = false;
  while (args.length > 0 && args[0] === "--tag") {
    tagged = true;
    args.splice(0, 1);
  }
  const p = popPath(args);
  if (p == null) return fail("badrequest", "usage: kiwi exec read [--tag] <path>");
  try {
    const data = fs.readFileSync(p, "utf8");
    return { ok: true, data: tagged ? taggedText(data) : data };
  } catch (err) {
    return errResult(err);
  }
}

const TAG_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ234567890";

function lineTag(line: string, lineNo: number): string {
  const normalized = line.replace(/\r$/, "").replace(/\s+$/, "");
  const seed = normalized === "" ? lineNo : 0;
  const A = TAG_ALPHABET.length;
  const h = Number(Bun.hash.xxHash32(normalized, seed)) % (A * A * A);
  return TAG_ALPHABET[Math.floor(h / (A * A)) % A]! + TAG_ALPHABET[Math.floor(h / A) % A]! + TAG_ALPHABET[h % A]!;
}

/** taggedText renders "N#TAG│ content" per line for pos-anchored edits. */
export function taggedText(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((ln, i) => `${i + 1}#${lineTag(ln, i + 1)}│ ${ln}`).join("\n");
}

interface LineEdit {
  pos: string;
  op: "replace" | "insertBefore" | "insertAfter" | "delete";
  newText?: string;
}

function applyLineEdits(text: string, ops: LineEdit[]): { ok: true; text: string } | { ok: false; code: string; message: string } {
  const trailingNl = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNl) lines.pop();
  const seen = new Set<number>();
  const sorted = [...ops].sort((a, b) => Number(b.pos.split("#")[0]) - Number(a.pos.split("#")[0]));
  for (const op of sorted) {
    const m = /^(\d+)#([A-Z2-9]{3})$/.exec(op.pos);
    if (!m) return { ok: false, code: "badrequest", message: `pos 형식 오류: ${op.pos} (예: 12#ABC)` };
    const lineNo = parseInt(m[1]!, 10);
    if (lineNo < 1 || lineNo > lines.length) return { ok: false, code: "badrequest", message: `줄 번호 범위 초과: ${op.pos} (전체 ${lines.length}줄)` };
    if (seen.has(lineNo)) return { ok: false, code: "badrequest", message: `같은 줄에 여러 연산: ${op.pos}` };
    seen.add(lineNo);
    const current = lines[lineNo - 1]!;
    if (lineTag(current, lineNo) !== m[2]) {
      return { ok: false, code: "conflict", message: `stale: ${op.pos} — 줄 내용이 읽은 뒤 바뀌었습니다. 다시 read --tag 하세요` };
    }
    switch (op.op) {
      case "replace":
        if (typeof op.newText !== "string") return { ok: false, code: "badrequest", message: `replace는 newText 필요: ${op.pos}` };
        lines[lineNo - 1] = op.newText;
        break;
      case "insertBefore":
      case "insertAfter":
        if (typeof op.newText !== "string") return { ok: false, code: "badrequest", message: `${op.op}는 newText 필요: ${op.pos}` };
        lines.splice(op.op === "insertBefore" ? lineNo - 1 : lineNo, 0, op.newText);
        break;
      case "delete":
        lines.splice(lineNo - 1, 1);
        break;
      default:
        return { ok: false, code: "badrequest", message: `알 수 없는 op: ${op.op}` };
    }
  }
  return { ok: true, text: lines.join("\n") + (trailingNl ? "\n" : "") };
}

async function cmdWrite(argv: string[], stdin: ReadableStream<Uint8Array> | null): Promise<ExecResult> {
  let p = "";
  let expectSha = "";
  const args = [...argv];
  while (args.length > 0) {
    const a = args[0]!;
    if (a === "--expect-sha") {
      if (args.length < 2) return fail("badrequest", "--expect-sha requires a value");
      expectSha = args[1]!;
      args.splice(0, 2);
    } else {
      if (p !== "") return fail("badrequest", "unexpected argument: " + a);
      p = a;
      args.splice(0, 1);
    }
  }
  if (p === "") return fail("badrequest", "usage: kiwi exec write [--expect-sha <sha>] <path>");

  if (expectSha !== "") {
    let current = "";
    try {
      current = shaHex(fs.readFileSync(p));
    } catch {
      // missing file counts as empty content
    }
    if (current !== expectSha) {
      return fail("conflict", `content changed since read (sha ${shortSha(current)}, expected ${shortSha(expectSha)})`);
    }
  }

  let content: Buffer;
  try {
    if (stdin) {
      content = Buffer.from(await new Response(stdin).arrayBuffer());
    } else {
      content = Buffer.alloc(0);
    }
  } catch (err) {
    return fail("error", "read stdin: " + String(err));
  }
  const dir = path.dirname(p);
  if (dir !== ".") {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (err) {
      return errResult(err);
    }
  }
  try {
    writeFileAtomic(p, content, 0o644);
  } catch (err) {
    return errResult(err);
  }
  return { ok: true, data: shaHex(content) };
}

function cmdLs(argv: string[]): ExecResult {
  const p = argv.length > 0 ? argv[0]! : ".";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (err) {
    return errResult(err);
  }
  let b = "";
  for (const e of entries) {
    b += (e.isDirectory() ? e.name + "/" : e.name) + "\n";
  }
  return { ok: true, data: b };
}

const MAX_TOOL_OUTPUT = 64 * 1024;

function capOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  return s.slice(0, MAX_TOOL_OUTPUT) + `\n… (${s.length - MAX_TOOL_OUTPUT}자 잘림)`;
}

async function cmdRun(argv: string[]): Promise<ExecResult> {
  const args = [...argv];
  let timeoutMs = 120_000;
  while (args.length > 0 && args[0] === "--timeout") {
    if (args.length < 2 || !/^\d+$/.test(args[1]!)) return fail("badrequest", "--timeout requires <ms>");
    timeoutMs = Math.min(parseInt(args[1]!, 10), 600_000);
    args.splice(0, 2);
  }
  if (args.length === 0) return fail("badrequest", "usage: kiwi exec run [--timeout <ms>] <command> [args…]");
  const started = Date.now();
  let proc;
  try {
    proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return fail("badrequest", "spawn 실패: " + String(err));
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = -1;
  } finally {
    clearTimeout(timer);
  }
  const stdout = capOutput(await new Response(proc.stdout).text());
  const stderr = capOutput(await new Response(proc.stderr).text());
  if (timedOut) return { ok: false, code: "timeout", message: `timeout after ${timeoutMs}ms`, data: JSON.stringify({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started }) };
  return { ok: true, data: JSON.stringify({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started }) };
}

function cmdGrep(argv: string[]): Promise<ExecResult> {
  const args = [...argv];
  let include = "";
  while (args.length > 0 && args[0] === "--include") {
    if (args.length < 2) return Promise.resolve(fail("badrequest", "--include requires a glob"));
    include = args[1]!;
    args.splice(0, 2);
  }
  if (args.length === 0) return Promise.resolve(fail("badrequest", "usage: kiwi exec grep <pattern> [--include <glob>] [path]"));
  const pattern = args.shift()!;
  const target = args.shift() ?? ".";
  const engines: string[][] = [
    ["rg", "-S", "-n", "--max-count", "50", ...(include ? ["-g", include] : []), "--", pattern, target],
    ["grep", "-rn", "-E", ...(include ? ["--include", include] : []), "--", pattern, target],
  ];
  return tryEngines(engines, pattern);
}

async function tryEngines(engines: string[][], pattern: string): Promise<ExecResult> {
  let lastErr: unknown = null;
  for (const cmd of engines) {
    let proc;
    try {
      proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      lastErr = err;
      continue;
    }
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode === 2 && /not found|no such file/i.test(stderr)) {
      lastErr = stderr;
      continue;
    }
    if (exitCode === 1) return { ok: true, data: "(검색어와 일치하는 결과 없음: " + pattern + ")" };
    if (exitCode === 0) {
      const lines = stdout.split("\n").slice(0, 200).join("\n");
      return { ok: true, data: capOutput(lines) };
    }
    return fail("error", `exit ${exitCode}: ${stderr.trim().slice(0, 400)}`);
  }
  return fail("error", "검색 엔진 없음(rg/grep): " + String(lastErr));
}

async function cmdGlob(argv: string[]): Promise<ExecResult> {
  if (argv.length === 0) return fail("badrequest", "usage: kiwi exec glob <pattern> [path]");
  const pattern = argv[0]!;
  const cwd = argv[1] ?? ".";
  const found: { p: string; mtime: number }[] = [];
  try {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: false })) {
      try {
        found.push({ p: rel, mtime: fs.statSync(path.join(cwd, rel)).mtimeMs });
      } catch {
        found.push({ p: rel, mtime: 0 });
      }
      if (found.length >= 500) break;
    }
  } catch (err) {
    return errResult(err as NodeJS.ErrnoException);
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const data = found.slice(0, 100).map((f) => f.p).join("\n");
  return { ok: true, data: data === "" ? "(일치하는 파일 없음: " + pattern + ")" : data };
}

async function cmdEdit(argv: string[], stdin: ReadableStream<Uint8Array> | null): Promise<ExecResult> {
  if (argv.length === 0) return fail("badrequest", "usage: kiwi exec edit <path>  (stdin: {\"edits\":[{oldText,newText}]})");
  const p = argv[0]!;
  let body: string;
  try {
    body = stdin ? await new Response(stdin).text() : "";
  } catch (err) {
    return fail("error", "stdin 읽기 실패: " + String(err));
  }
  let parsedBody: { edits?: { oldText?: string; newText?: string }[]; lineEdits?: { pos?: string; op?: string; newText?: string }[] };
  try {
    parsedBody = JSON.parse(body || "{}") as typeof parsedBody;
  } catch (err) {
    return fail("badrequest", "edits JSON 파싱 실패: " + String(err));
  }
  if (parsedBody.lineEdits !== undefined) {
    const lineOps = parsedBody.lineEdits.map((e) => ({
      pos: String(e.pos ?? ""),
      op: (e.op ?? "replace") as LineEdit["op"],
      newText: e.newText === undefined ? undefined : String(e.newText),
    }));
    if (lineOps.length === 0) return fail("badrequest", "lineEdits 비어 있음");
    let cur: string;
    try {
      cur = fs.readFileSync(p, "utf8");
    } catch (err) {
      return errResult(err);
    }
    const applied = applyLineEdits(cur, lineOps);
    if (!applied.ok) return fail(applied.code, applied.message);
    try {
      writeFileAtomic(p, Buffer.from(applied.text, "utf8"), 0o644);
    } catch (err) {
      return errResult(err);
    }
    return { ok: true, data: JSON.stringify({ applied: lineOps.length, sha: shaHex(Buffer.from(applied.text, "utf8")), content: applied.text.length > 256 * 1024 ? "(256KB 초과 — 내용 생략)" : applied.text }) };
  }
  const ops = (parsedBody.edits ?? []).map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }));
  if (ops.length === 0) return fail("badrequest", "edits 비어 있음");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (err) {
    return errResult(err);
  }
  for (const op of ops) {
    if (op.oldText === "") return fail("badrequest", "oldText 비어 있음");
    const count = text.split(op.oldText).length - 1;
    if (count === 0) return fail("badrequest", `oldText를 찾을 수 없음 (${snippet(op.oldText)})`);
    if (count > 1) return fail("badrequest", `oldText가 ${count}회 중복 — 유일하지 않음 (${snippet(op.oldText)})`);
    text = text.replace(op.oldText, op.newText);
  }
  try {
    writeFileAtomic(p, Buffer.from(text, "utf8"), 0o644);
  } catch (err) {
    return errResult(err);
  }
  return { ok: true, data: JSON.stringify({ applied: ops.length, sha: shaHex(Buffer.from(text, "utf8")), content: text.length > 256 * 1024 ? "(256KB 초과 — 내용 생략)" : text }) };
}

function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 60) + "…" : one;
}

function monDir(): string {
  return path.join(process.cwd(), ".kiwi-mon");
}

function monMetaPath(id: string): string {
  return path.join(monDir(), id + ".json");
}

function monReadMeta(id: string): { id: string; label: string; logPath: string; pid: number; startedAt: number; outOffset: number; stoppedAt?: number } {
  const raw = JSON.parse(fs.readFileSync(monMetaPath(id), "utf8")) as { id: string; label: string; logPath: string; pid: number; startedAt: number; outOffset: number; stoppedAt?: number };
  return raw;
}

function monWriteMeta(meta: Record<string, unknown>): void {
  const tmp = monMetaPath(String(meta.id)) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, monMetaPath(String(meta.id)));
}

function monAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdMon(argv: string[]): ExecResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "start":
      return monStart(rest);
    case "out":
      return monOut(rest);
    case "stop":
      return monStop(rest);
    case "list":
      return monList();
    default:
      return fail("badrequest", "usage: kiwi exec mon <start|out|stop|list> …");
  }
}

function monStart(argv: string[]): ExecResult {
  const args = [...argv];
  let label = "monitor";
  while (args.length > 0 && args[0] === "--label") {
    if (args.length < 2) return fail("badrequest", "--label requires a value");
    label = args[1]!;
    args.splice(0, 2);
  }
  if (args.length === 0) return fail("badrequest", "usage: kiwi exec mon start [--label <name>] <command> [args…]");
  const id = "mon_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(monDir(), { recursive: true, mode: 0o755 });
  const logPath = path.join(monDir(), id + ".log");
  const logFd = fs.openSync(logPath, "a");
  let proc;
  try {
    proc = Bun.spawn(["setsid", ...args], { stdin: "ignore", stdout: logFd, stderr: logFd });
  } catch (err) {
    return fail("badrequest", "spawn 실패(setsid 필요): " + String(err));
  }
  monWriteMeta({ id, label, argv: args, logPath, pid: proc.pid, startedAt: Date.now(), outOffset: 0 });
  return { ok: true, data: JSON.stringify({ id, label, pid: proc.pid }) };
}

function monOut(argv: string[]): ExecResult {
  const id = argv[0];
  if (!id) return fail("badrequest", "usage: kiwi exec mon out <id>");
  let meta;
  try {
    meta = monReadMeta(id);
  } catch (err) {
    return errResult(err);
  }
  const st = fs.statSync(meta.logPath);
  const from = Math.min(meta.outOffset, st.size);
  const len = Math.min(st.size - from, 64 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(meta.logPath, "r");
  fs.readSync(fd, buf, 0, len, from);
  fs.closeSync(fd);
  meta.outOffset = from + len;
  monWriteMeta(meta);
  const running = meta.stoppedAt === undefined && monAlive(meta.pid);
  return { ok: true, data: JSON.stringify({ id: meta.id, label: meta.label, running, newOutput: buf.toString("utf8") }) };
}

function monStop(argv: string[]): ExecResult {
  const id = argv[0];
  if (!id) return fail("badrequest", "usage: kiwi exec mon stop <id>");
  let meta;
  try {
    meta = monReadMeta(id);
  } catch (err) {
    return errResult(err);
  }
  try {
    process.kill(-meta.pid, "SIGTERM");
  } catch {
    // already dead
  }
  Bun.sleepSync(200);
  if (monAlive(meta.pid)) {
    try {
      process.kill(-meta.pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  monWriteMeta({ ...meta, stoppedAt: Date.now() });
  return { ok: true, data: JSON.stringify({ id: meta.id, stopped: true }) };
}

function monList(): ExecResult {
  fs.mkdirSync(monDir(), { recursive: true, mode: 0o755 });
  const out: { id: string; label: string; running: boolean; startedAt: number; bytes: number }[] = [];
  for (const f of fs.readdirSync(monDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = monReadMeta(f.slice(0, -5));
      out.push({
        id: meta.id,
        label: meta.label,
        running: meta.stoppedAt === undefined && monAlive(meta.pid),
        startedAt: meta.startedAt,
        bytes: fs.statSync(meta.logPath).size,
      });
    } catch {
      // skip broken meta
    }
  }
  return { ok: true, data: JSON.stringify(out) };
}

async function cmdLsp(argv: string[]): Promise<ExecResult> {
  const [sub, ...rest] = argv;
  const root = path.resolve(process.cwd());
  const pickLang = (arg?: string): string => {
    if (!arg || arg === "") return "";
    return langForFile(arg) !== "" ? langForFile(arg) : arg;
  };
  const started = async (lang: string): Promise<ExecResult> => {
    try {
      const status = await ensureLspDaemon(lang, root);
      return { ok: true, data: JSON.stringify(status) };
    } catch (err) {
      return fail("error", String(err));
    }
  };
  switch (sub) {
    case "start": {
      const lang = rest[0] ?? "";
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp start <lang>");
      return started(lang);
    }
    case "status": {
      const lang = pickLang(rest[0]);
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp status <lang|file>");
      try {
        const status = await lspCall(lang, root, { kind: "status" }, 3000);
        return { ok: true, data: JSON.stringify(status) };
      } catch {
        return { ok: true, data: JSON.stringify({ running: false, lang, root }) };
      }
    }
    case "stop": {
      const lang = pickLang(rest[0]);
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp stop <lang|file>");
      try {
        const out = await lspCall(lang, root, { kind: "stop" }, 5000);
        return { ok: true, data: JSON.stringify(out) };
      } catch {
        return { ok: true, data: JSON.stringify({ running: false, lang, root }) };
      }
    }
    case "diagnostics": {
      const file = rest[0];
      if (!file) return fail("badrequest", "usage: kiwi exec lsp diagnostics <file>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "diag", file: path.resolve(file) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "definition": {
      const [file, line, char] = rest;
      if (!file || !line || !char) return fail("badrequest", "usage: kiwi exec lsp definition <file> <line> <char>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "def", file: path.resolve(file), line: Number(line), char: Number(char) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "references": {
      const [file, line, char] = rest;
      if (!file || !line || !char) return fail("badrequest", "usage: kiwi exec lsp references <file> <line> <char>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "refs", file: path.resolve(file), line: Number(line), char: Number(char) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "symbols": {
      const file = rest[0];
      if (!file) return fail("badrequest", "usage: kiwi exec lsp symbols <file>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "symbols", file: path.resolve(file) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    default:
      return fail("badrequest", "usage: kiwi exec lsp <start|status|stop|diagnostics|definition|references|symbols> …");
  }
}

function cmdInfo(): ExecResult {
  const info: Record<string, string> = {
    version: Version,
    os: goos(),
    arch: goarch(),
  };
  return { ok: true, data: JSON.stringify(info) };
}

function goos(): string {
  return process.platform === "darwin" ? "darwin" : process.platform; // linux, darwin
}

function goarch(): string {
  return process.arch === "x64" ? "amd64" : process.arch; // amd64, arm64
}

function popPath(argv: string[]): string | null {
  if (argv.length === 0 || argv[0] === "") return null;
  return argv[0]!;
}

function shaHex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

function shortSha(s: string): string {
  return s.length > 12 ? s.slice(0, 12) : s;
}

function writeFileAtomic(p: string, content: Buffer, perm: number): void {
  const tmp = path.join(path.dirname(p), `.kiwi-${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, content);
  try {
    fs.chmodSync(tmp, perm);
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function errResult(err: unknown): ExecResult {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return fail("noent", String(err));
  if (e?.code === "EACCES" || e?.code === "EPERM") return fail("denied", String(err));
  return fail("error", String(err));
}

function fail(code: string, msg: string): ExecResult {
  return { ok: false, code, message: msg };
}
