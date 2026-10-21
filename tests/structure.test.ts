// Enforces the module boundaries the refactor established:
//   web → shared, server → shared, exec → shared
// with no server ↔ exec edges and no root-level module leakage.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...files(rel));
    else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

function imports(rel: string): string[] {
  const text = readFileSync(path.join(root, rel), "utf8");
  const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]!);
  return specs;
}

/** target resolves a relative import to a repo-relative path (null for packages). */
function target(rel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return path.relative(root, path.resolve(root, path.dirname(rel), spec)).split(path.sep).join("/");
}

function violations(from: string[], forbidden: string[]): string[] {
  const out: string[] = [];
  for (const file of from) {
    for (const spec of imports(file)) {
      const to = target(file, spec);
      if (to === null) continue;
      if (forbidden.some((f) => to === f || to.startsWith(f.endsWith("/") ? f : f + "/") || to === f.replace(/\.ts$/, ""))) {
        out.push(`${file} → ${spec}`);
      }
    }
  }
  return out;
}

const serverOnly = ["src/server", "src/llm.ts", "src/store.ts", "src/ssh.ts"];
const execOnly = ["src/exec"];

describe("module boundaries", () => {
  test("exec never imports server code", () => {
    expect(violations(files("src/exec"), serverOnly)).toEqual([]);
  });

  test("server never imports exec code", () => {
    expect(violations(files("src/server"), execOnly)).toEqual([]);
  });

  test("shared imports nothing above it", () => {
    expect(violations(files("src/shared"), [...serverOnly, ...execOnly])).toEqual([]);
  });

  test("web only reaches into shared", () => {
    expect(violations(files("web/src"), [...serverOnly, ...execOnly])).toEqual([]);
  });

  test("entrypoints stay on their side", () => {
    expect(violations(["src/kiwi.ts"], serverOnly)).toEqual([]);
    expect(violations(["src/kiwi-server.ts"], execOnly)).toEqual([]);
  });
});
