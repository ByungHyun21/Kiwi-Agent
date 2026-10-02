// kiwi exec subcommands: structured JSON file operations executed on work
// machines over SSH. Always prints exactly one ExecResult JSON on stdout.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "./updater.ts";
import type { ExecResult } from "./protocol.ts";

/** Version is reported by the info command. */
export const Version = VERSION;

/** Run executes one kiwi exec subcommand. argv excludes the leading "exec".
 *  Always prints exactly one ExecResult JSON on stdout; returns the exit code. */
export async function run(argv: string[], stdin: ReadableStream<Uint8Array> | null, stdout: typeof process.stdout): Promise<number> {
  let res: ExecResult;
  if (argv.length === 0) {
    res = fail("badrequest", "usage: kiwi exec <read|write|edit|ls|grep|glob|run|info> [args]");
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
  const p = popPath(argv);
  if (p == null) return fail("badrequest", "usage: kiwi exec read <path>");
  try {
    const data = fs.readFileSync(p, "utf8");
    return { ok: true, data };
  } catch (err) {
    return errResult(err);
  }
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
  let ops: { oldText: string; newText: string }[];
  try {
    const parsed = JSON.parse(body || "{}") as { edits?: { oldText?: string; newText?: string }[] };
    ops = (parsed.edits ?? []).map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }));
  } catch (err) {
    return fail("badrequest", "edits JSON 파싱 실패: " + String(err));
  }
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
