// Info and self-update subcommands.

import type { ExecResult } from "../shared/protocol.ts";
import { latestRelease, selfUpdate, VERSION } from "./updater.ts";
import { fail } from "./util.ts";

/** Version is reported by the info command. */
export const Version = VERSION;

export function cmdInfo(): ExecResult {
  const info: Record<string, string> = {
    version: Version,
    os: goos(),
    arch: goarch(),
  };
  return { ok: true, data: JSON.stringify(info) };
}

/** cmdUpdate self-updates this binary from GitHub Releases (binary mode
 *  replaces the executable in place) and reports the outcome. Progress goes
 *  to stderr so stdout keeps exactly one ExecResult document. */
export async function cmdUpdate(): Promise<ExecResult> {
  const rel = await latestRelease();
  if (!rel) return fail("error", "release lookup failed (network, rate limit, or no asset for this platform)");
  const res = await selfUpdate(rel, (line) => process.stderr.write(`kiwi update: ${line}\n`));
  if (res.status === "failed") return fail("error", res.reason);
  const version = res.status === "updated" ? res.tag.replace(/^v/, "") : Version;
  return { ok: true, data: JSON.stringify({ status: res.status, version }) };
}

function goos(): string {
  return process.platform === "darwin" ? "darwin" : process.platform; // linux, darwin
}

function goarch(): string {
  return process.arch === "x64" ? "amd64" : process.arch; // amd64, arm64
}
