// Server configuration, parsed once at startup instead of reading env vars
// from every module.

import { existsSync } from "node:fs";
import * as path from "node:path";

export interface ServerConfig {
  /** Listen address, e.g. ":5494" or "0.0.0.0:6002". */
  addr: string;
  /** Directory holding server.db and the SSH known_hosts file. */
  dataDir: string;
  /** SearXNG JSON API base URL, "" when web search is not configured. */
  searxngUrl: string;
  /** Built SPA directory, "" when missing. */
  webDist: string;
}

/** loadServerConfig reads KIWI_* env vars and --addr from argv. */
export function loadServerConfig(argv: string[], env: Record<string, string | undefined> = process.env): ServerConfig {
  let addr = env.KIWI_ADDR ?? ":5494";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-addr" || arg === "--addr") {
      addr = argv[i + 1] ?? addr;
      i++;
    } else if (arg.startsWith("--addr=")) {
      addr = arg.slice("--addr=".length);
    }
  }

  let dataDir = env.KIWI_DATA ?? "";
  if (dataDir === "") dataDir = `${env.HOME ?? "."}/.local/share/kiwi`;

  const configuredDist = env.KIWI_WEB_DIST;
  return {
    addr,
    dataDir,
    searxngUrl: env.SEARXNG_URL ?? "",
    webDist: configuredDist !== undefined ? configuredDist : defaultWebDist(),
  };
}

/** defaultWebDist picks the checked-out SPA build when no override is set. */
export function defaultWebDist(): string {
  const local = path.resolve("web/dist");
  return existsSync(local) ? local : "";
}
