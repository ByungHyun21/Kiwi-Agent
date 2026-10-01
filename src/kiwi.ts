// kiwi entrypoint: `kiwi exec ...` subcommand or the TUI.

import { run as execRun } from "./execcli.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "exec") {
    const code = await execRun(args.slice(1), Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>, process.stdout);
    process.exit(code);
  }
  const { run } = await import("./tui/model.ts");
  await run();
}

void main();
