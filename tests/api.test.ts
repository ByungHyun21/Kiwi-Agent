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
const pins: { machine: string; force: boolean }[] = [];
const runner: Runner = {
  async run(_machine: Machine, workdir: string, argv: string[], _payload?: Uint8Array | null, signal?: AbortSignal): Promise<ExecResult> {
    calls.push({ workdir, argv, signal });
    return reply;
  },
  async pin(machine: Machine, opts?: { force?: boolean }): Promise<ExecResult> {
    pins.push({ machine: machine.name, force: opts?.force === true });
    return { ok: true, data: JSON.stringify({ fingerprint: "SHA256:test" }) };
  },
};
const srv = new KiwiServer(store, runner, { addr: ":0", dataDir: dir, searxngUrl: "", webDist: "" });
const providerLlm = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "stub-model", context_length: 4096 }] });
    }
    return new Response("not found", { status: 404 });
  },
});
const providerBase = `http://127.0.0.1:${providerLlm.port}`;

afterAll(() => {
  providerLlm.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> {
  const req = new Request("http://localhost" + p, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await apiRoutes(srv, req, new URL(req.url));
  return { status: res.status, text: await res.text() };
}

async function post(p: string, body?: unknown): Promise<{ status: number; text: string }> {
  return call("POST", p, body);
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

describe("search settings", () => {
  test("saves, reads, and clears the SearXNG URL", async () => {
    const initial = await call("GET", "/api/settings/search");
    expect(JSON.parse(initial.text)).toEqual({ url: "", source: "none" });

    const saved = await call("PUT", "/api/settings/search", { url: "127.0.0.1:8888/" });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text)).toEqual({ url: "http://127.0.0.1:8888", source: "web" });

    const read = await call("GET", "/api/settings/search");
    expect(JSON.parse(read.text)).toEqual({ url: "http://127.0.0.1:8888", source: "web" });

    const cleared = await call("PUT", "/api/settings/search", { url: "" });
    expect(JSON.parse(cleared.text)).toEqual({ url: "", source: "none" });
  });

  test("rejects non-http URLs", async () => {
    const res = await call("PUT", "/api/settings/search", { url: "ftp://example.test" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("http");
  });

  test("falls back to SEARXNG_URL when no web setting exists", async () => {
    const envSrv = new KiwiServer(store, runner, {
      addr: ":0",
      dataDir: dir,
      searxngUrl: "http://env.example:8888",
      webDist: "",
    });
    const req = new Request("http://localhost/api/settings/search");
    const res = await apiRoutes(envSrv, req, new URL(req.url));
    expect(await res.json()).toEqual({ url: "http://env.example:8888", source: "env" });
  });

  test("test endpoint rejects an empty URL", async () => {
    const res = await post("/api/settings/search/test", { url: "" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("설정되지 않았습니다");
  });
});

describe("providers", () => {
  test("registers a provider and auto-corrects a missing /v1", async () => {
    const created = await call("POST", "/api/providers", {
      name: "stub",
      baseUrl: providerBase,
      apiKey: "secret",
    });
    expect(created.status).toBe(200);
    const provider = JSON.parse(created.text) as { name: string; baseUrl: string; hasApiKey: boolean };
    expect(provider).toEqual({ name: "stub", baseUrl: `${providerBase}/v1`, hasApiKey: true });

    const list = await call("GET", "/api/providers");
    const providers = JSON.parse(list.text) as Record<string, unknown>[];
    const stub = providers.find((item) => item.name === "stub");
    expect(stub).toEqual({ name: "stub", baseUrl: `${providerBase}/v1`, hasApiKey: true });
    expect(stub).not.toHaveProperty("apiKey");
  });

  test("keeps an explicit /v1 when it works", async () => {
    const created = await call("POST", "/api/providers", {
      name: "stub-v1",
      baseUrl: `${providerBase}/v1`,
      apiKey: "",
    });
    expect(created.status).toBe(200);
    expect(JSON.parse(created.text)).toEqual({
      name: "stub-v1",
      baseUrl: `${providerBase}/v1`,
      hasApiKey: false,
    });
    expect((await call("DELETE", "/api/providers/stub-v1")).status).toBe(204);
  });

  test("strips /v1 when the provider only exposes root /models", async () => {
    const rootLlm = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/models") {
          return Response.json({ data: [{ id: "root-model" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const rootBase = `http://127.0.0.1:${rootLlm.port}`;
      const created = await call("POST", "/api/providers", {
        name: "root-provider",
        baseUrl: `${rootBase}/v1`,
        apiKey: "",
      });
      expect(created.status).toBe(200);
      expect(JSON.parse(created.text)).toEqual({
        name: "root-provider",
        baseUrl: rootBase,
        hasApiKey: false,
      });
      expect((await call("DELETE", "/api/providers/root-provider")).status).toBe(204);
    } finally {
      rootLlm.stop(true);
    }
  });

  test("updates and renames a provider while preserving an omitted key", async () => {
    const res = await call("PUT", "/api/providers/stub", {
      name: "stub-renamed",
      baseUrl: providerBase,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      name: "stub-renamed",
      baseUrl: `${providerBase}/v1`,
      hasApiKey: true,
    });
    const list = JSON.parse((await call("GET", "/api/providers")).text) as Record<string, unknown>[];
    expect(list.find((item) => item.name === "stub-renamed")).toEqual({
      name: "stub-renamed",
      baseUrl: `${providerBase}/v1`,
      hasApiKey: true,
    });
  });

  test("renames a provider and updates the role that references it", async () => {
    const res = await call("PUT", "/api/providers/local", {
      name: "local-renamed",
      baseUrl: providerBase,
    });
    expect(res.status).toBe(200);
    const role = JSON.parse((await call("GET", "/api/roles/agent-chat")).text) as { provider: string };
    expect(role.provider).toBe("local-renamed");

    const restore = await call("PUT", "/api/providers/local-renamed", {
      name: "local",
      baseUrl: providerBase,
    });
    expect(restore.status).toBe(200);
  });

  test("deletes an unused provider and refuses one used by a role", async () => {
    const removed = await call("DELETE", "/api/providers/stub-renamed");
    expect(removed.status).toBe(204);
    const list = JSON.parse((await call("GET", "/api/providers")).text) as Record<string, unknown>[];
    expect(list.some((item) => item.name === "stub-renamed")).toBe(false);

    const used = await call("DELETE", "/api/providers/local");
    expect(used.status).toBe(409);
    expect(used.text).toContain("used by role");
  });

  test("discovers models from every provider", async () => {
    const llm = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "stub-model", context_length: 4096 }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await call("POST", "/api/providers", {
        name: "stub-models",
        baseUrl: `http://127.0.0.1:${llm.port}/v1`,
        apiKey: "",
      });
      const res = await call("GET", "/api/models?all=1&refresh=1");
      expect(res.status).toBe(200);
      const groups = JSON.parse(res.text) as { provider: string; models: string[]; error?: string }[];
      expect(groups.find((group) => group.provider === "stub-models")).toEqual({
        provider: "stub-models",
        models: ["stub-model"],
      });
    } finally {
      llm.stop(true);
    }
  });
});

describe("POST /api/machines/:name/pin", () => {
  test("pins or verifies the host key", async () => {
    const { status, text } = await post("/api/machines/box/pin");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, data: JSON.stringify({ fingerprint: "SHA256:test" }) });
    expect(pins.at(-1)).toEqual({ machine: "box", force: false });
  });

  test("force re-pins when requested", async () => {
    const { status } = await post("/api/machines/box/pin", { force: true });
    expect(status).toBe(200);
    expect(pins.at(-1)).toEqual({ machine: "box", force: true });
  });

  test("unknown machine → 404", async () => {
    const { status } = await post("/api/machines/nope/pin");
    expect(status).toBe(404);
  });
});
