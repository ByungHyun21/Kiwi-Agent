// kiwi entrypoint: `kiwi exec ...` — runs tool operations on work machines.
// The agent UI is the web app served by kiwi-server.

import { run as execRun } from "./exec/entry.ts";
import { maybeAutoUpdate } from "./exec/updater.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "exec") {
    // NOTE: no update check here — kiwi exec runs over SSH on work machines
    const code = await execRun(args.slice(1), Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>, process.stdout);
    process.exit(code);
  }
  if (args[0] === "update") {
    await maybeAutoUpdate(args);
    return;
  }
  console.log("usage: kiwi exec <...> | kiwi update");
  process.exit(args.length === 0 ? 0 : 1);
}

void main();
