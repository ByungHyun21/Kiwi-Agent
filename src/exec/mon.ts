// Background monitor subcommands (start/output/stop/list).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecResult } from "../shared/protocol.ts";
import { errResult, fail } from "./util.ts";

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

export function cmdMon(argv: string[]): ExecResult {
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
