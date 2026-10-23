// Runs kiwi exec tool operations on work machines over SSH (the system ssh
// client). Callers pass relative argv and a workdir; results come back as
// protocol.ExecResult. Each machine's host key is pinned on first use and
// enforced with a per-machine known_hosts file.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, Machine } from "./shared/protocol.ts";

const defaultExecPath = "~/.local/bin/kiwi";

/** MachineDB persists machine state for the runner. */
export interface MachineDB {
  touchMachine(name: string, state: string): Promise<void> | void;
  saveHostKey?(name: string, fingerprint: string): Promise<void> | void;
}

/** Runner executes one kiwi exec invocation on a machine. */
export interface Runner {
  run(machine: Machine, workdir: string, argv: string[], payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult>;
  /** Pin verifies the machine's host key and stores its fingerprint. */
  pin?(machine: Machine, opts?: { force?: boolean }): Promise<ExecResult>;
}

export interface SSHRunnerOptions {
  /** Directory for server data (host key pins live under known_hosts.d). */
  knownHostsDir?: string;
}

/** SSHRunner runs kiwi exec via the system ssh client. */
export class SSHRunner implements Runner {
  private db: MachineDB;
  private keyDir: string;
  private pending = new Map<string, Promise<ExecResult | null>>();

  constructor(db: MachineDB, opts: SSHRunnerOptions = {}) {
    this.db = db;
    const dir = opts.knownHostsDir ?? path.join(os.homedir(), ".local", "share", "kiwi");
    this.keyDir = path.join(dir, "known_hosts.d");
    try {
      mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    } catch {
      // best effort; run reports the failure when it needs the file
    }
  }

  /** pin fetches the current host key and stores it (or verifies the existing pin). */
  async pin(m: Machine, opts: { force?: boolean } = {}): Promise<ExecResult> {
    const err = await this.ensureHostKey(m, opts.force === true);
    if (err) return err;
    return { ok: true, data: JSON.stringify({ fingerprint: m.hostKey ?? "" }) };
  }

  /** Run executes argv on the machine inside workdir. */
  async run(m: Machine, workdir: string, argv: string[], payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult> {
    const pinErr = await this.ensureHostKey(m, false);
    if (pinErr) return pinErr;

    const execPath = m.execPath || defaultExecPath;
    const parts = ["cd", quote(workdir), "&&", quote(expandHome(execPath, m)), "exec"];
    for (const a of argv) parts.push(quote(a));
    const cmd = parts.join(" ");

    const controlDir = path.join(os.tmpdir(), "kiwi-ssh");
    try {
      mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    } catch {
      // best effort
    }
    // Isolate pooled connections by pinned fingerprint so a changed pin never
    // reuses an old ControlMaster.
    const pinTag = createHash("sha256").update(m.hostKey ?? "").digest("hex").slice(0, 8);
    const sshArgs = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "UpdateHostKeys=no",
      "-o", `UserKnownHostsFile=${this.hostKeyPath(m.name)}`,
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlDir}/ssh-%C-${pinTag}`,
      "-o", "ControlPersist=120",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-p", String(m.port),
      `${m.user}@${m.host}`,
      cmd,
    ];

    const proc = Bun.spawn(["ssh", ...sshArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    if (payload && payload.length > 0) {
      proc.stdin.write(payload);
    }
    await proc.stdin.end();

    let timedOut = false;
    const timer = signal
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, 60_000);
    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } catch {
      timedOut = true;
      exitCode = 255;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    void this.db.touchMachine(m.name, "connected");

    if (timedOut) return protoErr("timeout", "execution canceled");
    return decodeResult(stdout, stderr, exitCode);
  }

  /** ensureHostKey makes the per-machine known_hosts match the pinned key. */
  private async ensureHostKey(m: Machine, force: boolean): Promise<ExecResult | null> {
    if (!force) {
      const inflight = this.pending.get(m.name);
      if (inflight) return inflight;
    }
    const task = this.doEnsureHostKey(m, force);
    if (!force) {
      this.pending.set(m.name, task);
      try {
        return await task;
      } finally {
        this.pending.delete(m.name);
      }
    }
    return task;
  }

  private async doEnsureHostKey(m: Machine, force: boolean): Promise<ExecResult | null> {
    const file = this.hostKeyPath(m.name);
    if (!force && m.hostKey && existsSync(file)) {
      const pinned = readPinnedLine(file);
      if (pinned !== "" && hostKeyFingerprint(pinned) === m.hostKey) return null;
    }

    let out: string;
    try {
      out = await scanHostKeys(m);
    } catch (err) {
      return protoErr("unreachable", `host key scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const keys = parseHostKeys(out);
    if (keys.length === 0) {
      return protoErr("unreachable", `no SSH host keys found for ${m.host}:${m.port}`);
    }

    if (m.hostKey && !force) {
      const match = keys.find((line) => hostKeyFingerprint(line) === m.hostKey);
      if (!match) {
        const found = keys.map((line) => hostKeyFingerprint(line)).join(", ");
        return protoErr("hostkey", `host key mismatch for ${m.name}: pinned ${m.hostKey}, got ${found}`);
      }
      if (!writePinnedKey(file, m, match)) {
        return protoErr("error", `cannot write host key pin for ${m.name}`);
      }
      return null;
    }

    const chosen = chooseHostKey(keys);
    if (!chosen || !writePinnedKey(file, m, chosen)) {
      return protoErr("error", `cannot write host key pin for ${m.name}`);
    }
    m.hostKey = hostKeyFingerprint(chosen);
    try {
      await this.db.saveHostKey?.(m.name, m.hostKey);
    } catch (err) {
      return protoErr("error", `cannot save host key pin: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  private hostKeyPath(name: string): string {
    return path.join(this.keyDir, hostKeyFileName(name));
  }
}

/** scanHostKeys fetches all host keys advertised by a machine. */
async function scanHostKeys(m: Machine): Promise<string> {
  const proc = Bun.spawn(["ssh-keyscan", "-T", "5", "-p", String(m.port), m.host], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (stdout.trim() === "") {
    throw new Error(stderr.trim() || `ssh-keyscan exited with ${exitCode}`);
  }
  return stdout;
}

/** parseHostKeys drops comments and blank lines from ssh-keyscan output. */
export function parseHostKeys(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line.split(/\s+/).length >= 3);
}

/** chooseHostKey prefers modern algorithms (ed25519 first). */
export function chooseHostKey(lines: string[]): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const rank = hostKeyRank(line);
    if (rank < bestRank) {
      best = line;
      bestRank = rank;
    }
  }
  return best;
}

function hostKeyRank(line: string): number {
  const type = line.split(/\s+/)[1] ?? "";
  switch (type) {
    case "ssh-ed25519":
      return 0;
    case "ecdsa-sha2-nistp256":
      return 1;
    case "ecdsa-sha2-nistp384":
      return 2;
    case "ecdsa-sha2-nistp521":
      return 3;
    case "rsa-sha2-512":
    case "rsa-sha2-256":
    case "ssh-rsa":
      return 4;
    default:
      return 9;
  }
}

/** hostKeyFingerprint matches `ssh-keygen -lf` (SHA256, no padding). */
export function hostKeyFingerprint(line: string): string {
  const blob = line.trim().split(/\s+/)[2] ?? "";
  if (blob === "") return "";
  return "SHA256:" + createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
}

/** knownHostsSpec formats a host for a known_hosts entry. */
export function knownHostsSpec(host: string, port: number): string {
  if (host.includes(":")) return `[${host}]:${port}`;
  return port === 22 ? host : `${host}:${port}`;
}

/** hostKeyFileName derives a stable, collision-resistant file name. */
export function hostKeyFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "machine";
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${safe}-${hash}.known_hosts`;
}

function readPinnedLine(file: string): string {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) return trimmed;
    }
  } catch {
    // missing file
  }
  return "";
}

function writePinnedKey(file: string, m: Machine, line: string): boolean {
  const parts = line.trim().split(/\s+/);
  const type = parts[1] ?? "";
  const blob = parts[2] ?? "";
  if (type === "" || blob === "") return false;
  const tmp = file + ".tmp";
  try {
    writeFileSync(tmp, `${knownHostsSpec(m.host, m.port)} ${type} ${blob}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function decodeResult(stdout: string, stderr: string, exitCode: number): ExecResult {
  const trimmed = stdout.trim();
  if (trimmed !== "") {
    try {
      const res = JSON.parse(trimmed) as ExecResult;
      if (typeof res.ok === "boolean") return res;
    } catch {
      // no structured output: classify below
    }
  }
  let msg = stderr.trim();
  if (msg === "") msg = trimmed;
  if (exitCode === 255) {
    // ssh-level failure (connection refused, host key mismatch, ...)
    if (msg === "") msg = "ssh exited with status 255";
    if (/host key verification failed/i.test(msg)) {
      return protoErr("hostkey", msg);
    }
    return protoErr("unreachable", msg);
  }
  if (exitCode !== 0) {
    msg = `exit status ${exitCode}: ${msg}`;
  }
  if (msg.includes("not found")) {
    return protoErr("not-installed", "kiwi exec not found on machine: " + msg);
  }
  return protoErr("error", msg);
}

function expandHome(p: string, m: Machine): string {
  if (p.startsWith("~/")) return "/home/" + m.user + p.slice(1);
  return p;
}

/** quote wraps one argument for a POSIX remote shell. */
function quote(s: string): string {
  return "'" + s.replaceAll("'", `'\\''`) + "'";
}

function protoErr(code: string, msg: string): ExecResult {
  return { ok: false, code, message: msg };
}
