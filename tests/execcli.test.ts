// execcli tests: structured JSON results and exit codes.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/execcli.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-exec-"));
process.chdir(dir);

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function exec(argv: string[], stdin?: string): Promise<{ code: number; res: Record<string, unknown> }> {
  let stdout = "";
  const fake = { write: (s: unknown) => (stdout += String(s)) } as unknown as typeof process.stdout;
  const stream =
    stdin === undefined
      ? null
      : (new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(stdin)); c.close(); } }) as unknown as ReadableStream<Uint8Array>);
  const code = await run(argv, stream, fake);
  return { code, res: JSON.parse(stdout) as Record<string, unknown> };
}

describe("kiwi exec", () => {
  test("usage on empty argv", async () => {
    const { code, res } = await exec([]);
    expect(code).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("badrequest");
  });

  test("read missing file → noent", async () => {
    const { code, res } = await exec(["read", "missing.txt"]);
    expect(code).toBe(1);
    expect(res.code).toBe("noent");
  });

  test("write + read roundtrip", async () => {
    const { code, res } = await exec(["write", "a/b.txt"], "내용\n");
    expect(code).toBe(0);
    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe("string"); // sha
    const { res: r2 } = await exec(["read", "a/b.txt"]);
    expect(r2.data).toBe("내용\n");
    expect(readFileSync(path.join(dir, "a/b.txt"), "utf8")).toBe("내용\n");
  });

  test("write --expect-sha conflict", async () => {
    const first = await exec(["write", "c.txt"], "v1");
    const sha1 = first.res.data as string; // write returns the content sha
    const wrong = await exec(["write", "--expect-sha", "f".repeat(64), "c.txt"], "v2");
    expect(wrong.code).toBe(1);
    expect(wrong.res.code).toBe("conflict");
    const ok = await exec(["write", "--expect-sha", sha1, "c.txt"], "v2");
    expect(ok.code).toBe(0); // content still v1, matches the pin
    const stale = await exec(["write", "--expect-sha", sha1, "c.txt"], "v3");
    expect(stale.code).toBe(1); // content is now v2, pin no longer matches
    expect(stale.res.code).toBe("conflict");
    const { res } = await exec(["read", "c.txt"]);
    expect(res.data).toBe("v2");
  });

  test("ls lists entries", async () => {
    await exec(["write", "d.txt"], "x");
    const { res } = await exec(["ls"]);
    expect((res.data as string).split("\n")).toContain("d.txt");
  });

  test("info reports version and platform", async () => {
    const { res } = await exec(["info"]);
    const info = JSON.parse(res.data as string) as Record<string, string>;
    expect(info.version).toBe("dev");
    expect(info.os).toBeTypeOf("string");
    expect(info.arch).toBeTypeOf("string");
  });

  test("unknown command → badrequest", async () => {
    const { code, res } = await exec(["bogus"]);
    expect(code).toBe(1);
    expect(res.code).toBe("badrequest");
  });
});
