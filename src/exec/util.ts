// Shared result and output helpers for kiwi exec subcommands.

import type { ExecResult } from "../shared/protocol.ts";

const MAX_TOOL_OUTPUT = 64 * 1024;

export function capOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  return s.slice(0, MAX_TOOL_OUTPUT) + `\n… (${s.length - MAX_TOOL_OUTPUT}자 잘림)`;
}

export function errResult(err: unknown): ExecResult {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return fail("noent", String(err));
  if (e?.code === "EACCES" || e?.code === "EPERM") return fail("denied", String(err));
  return fail("error", String(err));
}

export function fail(code: string, msg: string): ExecResult {
  return { ok: false, code, message: msg };
}
