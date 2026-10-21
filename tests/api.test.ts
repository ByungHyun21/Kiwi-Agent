// API tests: the machine update endpoint drives `kiwi exec update` remotely.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult, Machine } from "../src/shared/protocol.ts";
import { apiRoutes } from "../src/server/api.ts";
import { KiwiServer } from "../src/server/server.ts";
import type { Runner } from "../src/ssh.ts";
import { Store } from "../src/store.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-api-"));
const store = Store.open(path.join(dir, "server.db"));
store.saveMachine({ name: "box", host: "10.0.0.5", port: 22, user: "u", state: "unknown" });

let reply: ExecResult = { ok: true, data: JSON.stringify({ status: "current", version: "0.1.0" }) };
const calls: { workdir: string; argv: string[]; signal?: AbortSignal }[] = [];
const runner: Runner = {
  async run(_machine: Machine, workdir: string, argv: string[], _payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult> {
    calls.push({ workdir, argv, signal });
    return reply;
  },
};
const srv = new KiwiServer(store, runner, { addr: ":0", dataDir: dir, authRequired: false, webDist: "" });

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(p: string): Promise<{ status: number; text: string }> {
  const req = new Request("http://localhost" + p, { method: "POST" });
  const res = await apiRoutes(srv, req, new URL(req.url));
  return { status: res.status, text: await res.text() };
}

describe("POST /api/machines/:name/update", () => {
  test("runs kiwi exec update on the machine and returns its result", async () => {
    reply = { ok: true, data: JSON.stringify({ status: "updated", version: "0.1.1" }) };
    const { status, text } = await post("/api/machines/box/update");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual(reply);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.workdir).toBe(".");
    expect(calls[0]!.argv).toEqual(["update"]);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("propagates exec failures as the JSON result", async () => {
    reply = { ok: false, code: "not-installed", message: "kiwi exec not found on machine" };
    const { status, text } = await post("/api/machines/box/update");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual(reply);
  });

  test("unknown machine → 404", async () => {
    const { status, text } = await post("/api/machines/nope/update");
    expect(status).toBe(404);
    expect(text).toContain("machine not found");
  });
});
