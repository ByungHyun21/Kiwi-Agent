// Shell execution subcommand.

import type { ExecResult } from "../shared/protocol.ts";
import { capOutput, fail } from "./util.ts";

export async function cmdRun(argv: string[]): Promise<ExecResult> {
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
