// Compile the tui2 client into a single executable. The OpenTUI solid
// transform must run at BUILD time (bunfig preload only applies to `bun run`),
// otherwise whitespace text children crash the native scene at startup.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["src/kiwi-tui2.ts"],
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  compile: { outfile: "kiwi-tui2" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built kiwi-tui2");
