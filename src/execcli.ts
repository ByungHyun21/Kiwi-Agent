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
    res = fail("badrequest", "usage: kiwi exec <read|write|ls|info> [args]");
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
    case "ls":
      return cmdLs(rest);
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
