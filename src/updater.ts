// Self-update for kiwi: GitHub Releases based.
// - Binary mode (bun build --compile): downloads the release tarball and
//   atomically replaces the running executable, then relaunches.
// - Source mode (bun src/kiwi.ts): `git pull --ff-only` in the project dir.

import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Keep in sync with package.json. Releases are tagged v<VERSION>. */
export const VERSION = "0.1.0";

const REPO = "ByungHyun21/Kiwi-Agent";

export interface Release {
  tag: string;
  assetUrl: string;
}

export type UpdateResult =
  | { status: "updated"; tag: string }
  | { status: "current" }
  | { status: "failed"; reason: string };

function releasesAPI(): string {
  return process.env.KIWI_RELEASES_API ?? `https://api.github.com/repos/${REPO}/releases/latest`;
}

/** runningFromSource reports whether kiwi runs from a checkout (bun src/…). */
export function runningFromSource(): boolean {
  return import.meta.path.endsWith(".ts");
}

function platformTag(): string {
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const archName = process.arch === "x64" ? "amd64" : process.arch;
  return `${osName}_${archName}`;
}

function semver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

/** fmtTag normalizes a release tag for display (always v-prefixed). */
function fmtTag(tag: string): string {
  return tag.startsWith("v") ? tag : "v" + tag;
}

/** isNewer reports whether b is a strictly newer semver than a. */
export function isNewer(a: string, b: string): boolean {
  const pa = semver(a);
  const pb = semver(b);
  if (!pa || !pb) return false;
  if (pa[0] !== pb[0]) return pb[0] > pa[0];
  if (pa[1] !== pb[1]) return pb[1] > pa[1];
  return pb[2] > pa[2];
}

/** latestRelease queries GitHub for the newest release with an asset for
 *  this platform. Returns null when offline, rate-limited, or no release. */
export async function latestRelease(timeoutMs = 2500): Promise<Release | null> {
  try {
    const resp = await fetch(releasesAPI(), {
      headers: { "User-Agent": "kiwi-updater", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const tag = data.tag_name ?? "";
    if (!tag) return null;
    const want = `kiwi_${platformTag()}`;
    const asset = (data.assets ?? []).find((a) => (a.name ?? "").startsWith(want));
    if (!asset?.browser_download_url) return null;
    return { tag, assetUrl: asset.browser_download_url };
  } catch {
    return null;
  }
}

/** selfUpdate installs a newer release when one exists. Never throws.
 *  Binary mode replaces the running executable atomically; source mode
 *  pulls the checkout. */
export async function selfUpdate(rel?: Release, log: (line: string) => void = () => {}): Promise<UpdateResult> {
  const release = rel ?? (await latestRelease());
  if (!release) return { status: "current" };
  if (!isNewer(VERSION, release.tag)) return { status: "current" };
  if (runningFromSource()) return sourceUpdate(release.tag, log);
  return binaryUpdate(release, log);
}

async function sourceUpdate(tag: string, log: (line: string) => void): Promise<UpdateResult> {
  log(`${fmtTag(tag)} 업데이트 발견 — git pull 중…`);
  const dir = path.dirname(import.meta.path);
  const proc = Bun.spawnSync(["git", "-C", dir, "pull", "--ff-only"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    return { status: "failed", reason: err || "git pull 실패" };
  }
  return { status: "updated", tag };
}

async function binaryUpdate(rel: Release, log: (line: string) => void): Promise<UpdateResult> {
  const exe = process.execPath;
  log(`${fmtTag(rel.tag)} 업데이트 다운로드 중…`);
  let tmp: string | null = null;
  try {
    const resp = await fetch(rel.assetUrl, { signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) return { status: "failed", reason: `HTTP ${resp.status}` };
    tmp = mkdtempSync(path.join(os.tmpdir(), "kiwi-update-"));
    const tgz = path.join(tmp, "kiwi.tgz");
    await Bun.write(tgz, resp);
    const untar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", tmp]);
    if (untar.exitCode !== 0) return { status: "failed", reason: "압축 해제 실패" };
    const extracted = path.join(tmp, "kiwi");
    if (!existsSync(extracted)) return { status: "failed", reason: "아카이브에 kiwi 바이너리가 없습니다" };
    chmodSync(extracted, 0o755);
    // stage next to the target so the final rename is atomic (same fs)
    const staged = path.join(path.dirname(exe), `.kiwi-update-${process.pid}`);
    copyFileSync(extracted, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, exe);
    log(`${fmtTag(rel.tag)} 업데이트 완료`);
    return { status: "updated", tag: rel.tag };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** relaunch re-executes kiwi with the same arguments (picking up the newly
 *  installed binary) and returns its exit code. */
export async function relaunch(args: string[]): Promise<number> {
  const script = import.meta.path;
  const cmd = script.endsWith(".ts") ? [process.execPath, script, ...args] : [process.execPath, ...args];
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

/** maybeAutoUpdate runs at kiwi startup: when a newer release exists
 *  (binary mode only), install it and relaunch into the new version —
 *  this function never returns in that case. Skip with --no-update or
 *  KIWI_NO_UPDATE=1. */
export async function maybeAutoUpdate(args: string[]): Promise<void> {
  if (process.env.KIWI_NO_UPDATE === "1" || args.includes("--no-update")) return;
  if (runningFromSource()) return; // source checkouts update via /update (git pull)
  const rel = await latestRelease();
  if (!rel || !isNewer(VERSION, rel.tag)) return;
  const res = await selfUpdate(rel, (line) => console.log("kiwi:", line));
  if (res.status !== "updated") {
    if (res.status === "failed") console.error("kiwi: update 실패, 현재 버전으로 실행합니다 —", res.reason);
    return;
  }
  console.log(`kiwi: ${fmtTag(res.tag)} 로 업데이트했습니다, 새 버전을 실행합니다…`);
  process.exit(await relaunch(args));
}
