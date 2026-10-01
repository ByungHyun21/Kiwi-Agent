// kiwi entrypoint: `kiwi exec ...` subcommand or the TUI.

import { run as execRun } from "./execcli.ts";
import { maybeAutoUpdate } from "./updater.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "exec") {
    // NOTE: no update check here — kiwi exec runs over SSH on work machines
    const code = await execRun(args.slice(1), Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>, process.stdout);
    process.exit(code);
  }
  await maybeAutoUpdate(args);
  const { run } = await import("./tui/model.ts");
  await run();
}

void main();
