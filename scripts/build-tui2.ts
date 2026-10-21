// Compile the tui2 client into a single executable. The OpenTUI solid
// transform must run at BUILD time (bunfig preload only applies to `bun run`),
// otherwise whitespace text children crash the native scene at startup.
//
// Usage:
//   bun run scripts/build-tui2.ts                       # host build
//   bun run scripts/build-tui2.ts --target bun-linux-arm64 --outfile path
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

let target: string | undefined;
let outfile = "kiwi-tui2";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target") target = args[++i];
  else if (args[i]!.startsWith("--target=")) target = args[i]!.slice("--target=".length);
  else if (args[i] === "--outfile") outfile = args[++i]!;
}

const result = await Bun.build({
  entrypoints: ["src/kiwi-tui2.ts"],
  target: "bun",
  ...(target ? { target: target as "bun" } : {}),
  plugins: [createSolidTransformPlugin()],
  compile: { outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}${target ? ` (${target})` : ""}`);
