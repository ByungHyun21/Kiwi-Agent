// Updater tests: version comparison and release lookup (against a local mock).

import { afterAll, describe, expect, test } from "bun:test";
import { isNewer, latestRelease, runningFromSource, selfUpdate, VERSION, type Release } from "../src/updater.ts";

describe("isNewer", () => {
  test("patch bumps", () => {
    expect(isNewer("0.1.0", "v0.1.1")).toBe(true);
    expect(isNewer("0.1.1", "v0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "v0.1.0")).toBe(false);
  });
  test("minor and major bumps", () => {
    expect(isNewer("0.1.0", "v0.2.0")).toBe(true);
    expect(isNewer("0.9.5", "v1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "v0.99.99")).toBe(false);
  });
  test("numeric (not lexicographic) comparison", () => {
    expect(isNewer("0.1.10", "v0.1.9")).toBe(false);
    expect(isNewer("0.1.9", "v0.1.10")).toBe(true);
  });
  test("garbage tags never trigger an update", () => {
    expect(isNewer("0.1.0", "")).toBe(false);
    expect(isNewer("0.1.0", "latest")).toBe(false);
    expect(isNewer("dev", "v0.2.0")).toBe(false);
  });
});

const servers: Bun.Server<unknown>[] = [];

function mockRelease(body: unknown | Response): Bun.Server<unknown> {
  const s = Bun.serve({
    port: 0,
    fetch: () => (body instanceof Response ? body : Response.json(body)),
  });
  servers.push(s);
  return s;
}

afterAll(() => {
  for (const s of servers) s.stop(true);
  delete process.env.KIWI_RELEASES_API;
});

function withAPI(s: Bun.Server<unknown>): void {
  process.env.KIWI_RELEASES_API = `http://localhost:${s.port}/latest`;
}

describe("latestRelease", () => {
  test("finds the platform asset", async () => {
    const osName = process.platform === "darwin" ? "darwin" : "linux";
    const archName = process.arch === "x64" ? "amd64" : process.arch;
    withAPI(
      mockRelease({
        tag_name: "v9.9.9",
        assets: [
          { name: `kiwi_${osName}_${archName}.tar.gz`, browser_download_url: "https://example.invalid/kiwi.tgz" },
          { name: "kiwi_linux_arm64.tar.gz", browser_download_url: "https://example.invalid/other.tgz" },
        ],
      }),
    );
    const rel = await latestRelease(1000);
    expect(rel?.tag).toBe("v9.9.9");
    expect(rel?.assetUrl).toBe("https://example.invalid/kiwi.tgz");
  });

  test("404 (no releases yet) → null", async () => {
    withAPI(mockRelease(new Response("not found", { status: 404 })));
    expect(await latestRelease(1000)).toBeNull();
  });

  test("unreachable endpoint → null (never throws)", async () => {
    process.env.KIWI_RELEASES_API = "http://localhost:1/latest";
    expect(await latestRelease(300)).toBeNull();
    delete process.env.KIWI_RELEASES_API;
  });

  test("release without a matching asset → null", async () => {
    withAPI(
      mockRelease({
        tag_name: "v9.9.9",
        assets: [{ name: "kiwi_solaris_sparc.tar.gz", browser_download_url: "x" }],
      }),
    );
    expect(await latestRelease(1000)).toBeNull();
  });
});

describe("selfUpdate", () => {
  test("same version → no-op", async () => {
    withAPI(mockRelease({ tag_name: `v${VERSION}`, assets: [] }));
    expect(await selfUpdate()).toEqual({ status: "current" });
  });

  test("older release than local version → no-op (no downgrade)", async () => {
    withAPI(mockRelease({ tag_name: "v0.0.1", assets: [] }));
    expect(await selfUpdate()).toEqual({ status: "current" });
  });
});

describe("source detection", () => {
  test("under bun test everything runs from .ts sources", () => {
    expect(runningFromSource()).toBe(true);
  });
});

// keep the Release type referenced for the mock helpers above
export type { Release };
