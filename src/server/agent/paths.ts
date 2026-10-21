// Path and command guards shared by the agent tool layer.

import * as path from "node:path";

export function pathErr(p: string): string {
  return "오류: 경로는 작업 폴더 안의 상대 경로여야 합니다: " + p;
}

/** tokenize splits a shell-like command string into argv, honoring quotes. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (cur !== "" || has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
  }
  if (cur !== "" || has) out.push(cur);
  return out;
}

/** safePath rejects absolute paths and traversal outside the workdir. */
export function safePath(p: string): boolean {
  if (p === "" || p.startsWith("/")) return false;
  const clean = path.posix.normalize(p);
  return clean !== ".." && !clean.startsWith("../");
}
