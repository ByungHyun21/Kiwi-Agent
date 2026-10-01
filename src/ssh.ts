// Runs kiwi exec tool operations on work machines over SSH (the system ssh
// client). Callers pass relative argv and a workdir; results come back as
// protocol.ExecResult. Connection reuse is delegated to ssh ControlMaster.

import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, Machine } from "./protocol.ts";

const defaultExecPath = "~/.local/bin/kiwi";

/** MachineDB persists machine state for the runner. */
export interface MachineDB {
  touchMachine(name: string, state: string): Promise<void> | void;
}

/** Runner executes one kiwi exec invocation on a machine. */
export interface Runner {
  run(machine: Machine, workdir: string, argv: string[], payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult>;
}

export interface SSHRunnerOptions {
  /** Directory for the dedicated known_hosts file (TOFU pinning). */
  knownHostsDir?: string;
}

/** SSHRunner runs kiwi exec via the system ssh client. */
export class SSHRunner implements Runner {
  private db: MachineDB;
  private knownHosts: string;

  constructor(db: MachineDB, opts: SSHRunnerOptions = {}) {
    this.db = db;
    const dir = opts.knownHostsDir ?? path.join(os.homedir(), ".local", "share", "kiwi");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch {
      // best effort
    }
    this.knownHosts = path.join(dir, "known_hosts");
  }

  /** Run executes argv on the machine inside workdir. */
  async run(m: Machine, workdir: string, argv: string[], payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult> {
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
    const sshArgs = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlDir}/ssh-%C`,
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
