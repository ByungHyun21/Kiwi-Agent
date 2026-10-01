// Persisted client preference file.

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Lang } from "./lang.ts";
import { defaultLang, validLang } from "./lang.ts";

export interface Config {
  language: string;
  server?: string; // host:port
  token?: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || `${process.env.HOME ?? "."}/.config`;
  return path.join(base, "kiwi", "config.json");
}

/** loadConfig reads stored preferences, falling back to defaults. */
export function loadConfig(): Config {
  const cfg = readConfigFile();
  if (!validLang(cfg.language)) {
    cfg.language = defaultLang;
  }
  return cfg;
}

function readConfigFile(): Config {
  const p = configPath();
  try {
    const data = readFileSync(p, "utf8");
    return JSON.parse(data) as Config;
  } catch {
    return { language: "" };
  }
}

/** saveConfig persists preferences, creating the config directory. */
export function saveConfig(cfg: Config): void {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o644 });
}

/** loadLang reads the stored language, falling back to the default. */
export function loadLang(): Lang {
  return loadConfig().language as Lang;
}

/** saveLang persists the language preference. */
export function saveLang(l: Lang): void {
  const cfg = loadConfig();
  cfg.language = l;
  saveConfig(cfg);
}

/** saveServer persists the server address and token. */
export function saveServer(addr: string, token: string): void {
  const cfg = loadConfig();
  cfg.server = addr;
  cfg.token = token;
  saveConfig(cfg);
}

/** configExists reports whether a preference file is present. */
export function configExists(): boolean {
  return existsSync(configPath());
}

// re-export for parity with the Go layout
export { validLang };
