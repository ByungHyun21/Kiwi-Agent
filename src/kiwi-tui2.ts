// OpenTUI solid transform runtime (build-time transform happens in scripts/build-tui2.ts)
import "@opentui/solid/preload";
// kiwi TUI v2 entrypoint: OpenTUI-based client (Phase 1 split-footer).
import { run } from "./tui2/app.tsx";

void run();
