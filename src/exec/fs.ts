// File and search subcommands: read, write, edit, ls, grep, glob.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecResult } from "../shared/protocol.ts";
import { capOutput, errResult, fail } from "./util.ts";

export function cmdRead(argv: string[]): ExecResult {
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

export async function cmdWrite(argv: string[], stdin: ReadableStream<Uint8Array> | null): Promise<ExecResult> {
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

export function cmdLs(argv: string[]): ExecResult {
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

export function cmdGrep(argv: string[]): Promise<ExecResult> {
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

export async function cmdGlob(argv: string[]): Promise<ExecResult> {
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

export async function cmdEdit(argv: string[], stdin: ReadableStream<Uint8Array> | null): Promise<ExecResult> {
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

function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 60) + "…" : one;
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
