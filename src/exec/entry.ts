// kiwi exec entrypoint: structured JSON operations executed on work machines
// over SSH. Always prints exactly one ExecResult JSON on stdout.

import * as path from "node:path";
import type { ExecResult } from "../shared/protocol.ts";
import { cmdEdit, cmdGlob, cmdGrep, cmdLs, cmdRead, cmdWrite } from "./fs.ts";
import { cmdLsp } from "./lsp.ts";
import { runLspDaemon } from "./lspbroker.ts";
import { cmdMon } from "./mon.ts";
import { cmdRun } from "./run.ts";
import { cmdInfo, cmdUpdate } from "./sys.ts";
import { fail } from "./util.ts";

/** Run executes one kiwi exec subcommand. argv excludes the leading "exec".
 *  Always prints exactly one ExecResult JSON on stdout; returns the exit code. */
export async function run(argv: string[], stdin: ReadableStream<Uint8Array> | null, stdout: typeof process.stdout): Promise<number> {
  let res: ExecResult = { ok: false, code: "error", message: "unreachable" };
  if (argv.length === 0) {
    res = fail("badrequest", "usage: kiwi exec <read|write|edit|ls|grep|glob|run|mon|lsp|info|update> [args]");
  } else if (argv[0] === "lsp-serve") {
    const lang = argv[argv.indexOf("--lang") + 1] ?? "";
    const root = argv[argv.indexOf("--root") + 1] ?? process.cwd();
    if (lang === "") {
      res = fail("badrequest", "lsp-serve requires --lang");
    } else {
      runLspDaemon({ lang, root: path.resolve(root) });
      await new Promise(() => {});
    }
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
    case "mon":
      return cmdMon(rest);
    case "lsp":
      return cmdLsp(rest);
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
    case "update":
      return cmdUpdate();
    default:
      return fail("badrequest", "unknown command: " + cmd);
  }
}
