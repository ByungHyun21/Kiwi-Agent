// REST API for the web app: machines, projects, sessions, roles, settings.

import { Client as LLMClient } from "../llm.ts";
import type { Machine, Project, ProviderInfo } from "../shared/protocol.ts";
import { ConflictError, NotFoundError, Store } from "../store.ts";
import { probeSearxng } from "./agent/websearch.ts";
import type { KiwiServer } from "./server.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v) + "\n", { status, headers: jsonHeaders });
}

function fail(msg: string, status: number): Response {
  return new Response(msg + "\n", { status });
}

function publicProvider(p: { name: string; baseUrl: string; apiKey?: string }): ProviderInfo {
  return { name: p.name, baseUrl: p.baseUrl, hasApiKey: (p.apiKey ?? "") !== "" };
}

/** normalizeHttpURL validates an HTTP(S) base and strips trailing slashes. */
function normalizeHttpURL(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let value = raw.trim();
  if (value === "") return { ok: true, url: "" };
  if (value.length > 2048) return { ok: false, error: "URL이 너무 깁니다" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "http://" + value;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "URL 형식이 올바르지 않습니다" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "http:// 또는 https:// 주소만 사용할 수 있습니다" };
  }
  u.hash = "";
  u.search = "";
  return { ok: true, url: u.toString().replace(/\/+$/, "") };
}

/** providerURLCandidates tries the entered URL first, then the /v1 variant. */
function providerURLCandidates(url: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  const candidates = [url];
  if (path.endsWith("/v1")) {
    u.pathname = path.slice(0, -3) || "/";
  } else {
    u.pathname = path + "/v1";
  }
  candidates.push(u.toString().replace(/\/+$/, ""));
  return [...new Set(candidates)];
}

/** resolveProviderBaseURL probes /models with and without /v1 and returns the working base. */
async function resolveProviderBaseURL(
  raw: string,
  apiKey: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const normalized = normalizeHttpURL(raw);
  if (!normalized.ok) return normalized;
  if (normalized.url === "") return { ok: false, error: "baseUrl required" };
  const candidates = providerURLCandidates(normalized.url);
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await new LLMClient(candidate, apiKey, "").listModels(AbortSignal.timeout(3_000), true);
      return { ok: true, url: candidate };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push(`${candidate}: ${detail.slice(0, 180)}`);
    }
  }
  return {
    ok: false,
    error: `모델 조회 실패 — 시도한 URL: ${candidates.join(", ")} / ${failures.join(" | ")}`,
  };
}

/** apiRoutes dispatches /api/* requests. */
export async function apiRoutes(s: KiwiServer, req: Request, url: URL): Promise<Response> {
  // health is public (parity with the Go server)
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json({ status: "ok" });
  }

  const path = url.pathname;
  const method = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  // ---- search settings ----
  if (path === "/api/settings/search" && method === "GET") {
    return json({ url: s.searchURL(), source: s.searchSource() });
  }
  if (path === "/api/settings/search" && method === "PUT") {
    let body: { url?: string };
    try {
      body = (await req.json()) as { url?: string };
    } catch {
      return fail("bad body", 400);
    }
    const normalized = normalizeHttpURL(typeof body.url === "string" ? body.url : "");
    if (!normalized.ok) return fail(normalized.error, 400);
    s.store.setSetting("searxng_url", normalized.url);
    return json({ url: s.searchURL(), source: s.searchSource() });
  }
  if (path === "/api/settings/search/test" && method === "POST") {
    let raw = "";
    try {
      const body = (await req.json()) as { url?: string };
      raw = typeof body.url === "string" ? body.url : s.searchURL();
    } catch {
      raw = s.searchURL();
    }
    const normalized = normalizeHttpURL(raw);
    if (!normalized.ok) return fail(normalized.error, 400);
    if (normalized.url === "") return fail("SearXNG 주소가 설정되지 않았습니다", 400);
    return json(await probeSearxng(normalized.url));
  }

  // ---- providers ----
  if (path === "/api/providers" && method === "GET") {
    return json(s.store.providers().map(publicProvider));
  }
  if (path === "/api/providers" && method === "POST") {
    let body: { name?: string; baseUrl?: string; apiKey?: string };
    try {
      body = (await req.json()) as { name?: string; baseUrl?: string; apiKey?: string };
    } catch {
      return fail("bad body", 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || name.length > 64) return fail("name required (max 64 chars)", 400);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const resolved = await resolveProviderBaseURL(
      typeof body.baseUrl === "string" ? body.baseUrl : "",
      apiKey,
    );
    if (!resolved.ok) return fail(resolved.error, 400);
    s.store.saveProvider({ name, baseUrl: resolved.url, apiKey });
    return json({ name, baseUrl: resolved.url, hasApiKey: apiKey !== "" });
  }
  if (seg[0] === "api" && seg[1] === "providers" && seg.length === 3 && method === "PUT") {
    const oldName = decodeURIComponent(seg[2]!);
    let body: { name?: string; baseUrl?: string; apiKey?: string };
    try {
      body = (await req.json()) as { name?: string; baseUrl?: string; apiKey?: string };
    } catch {
      return fail("bad body", 400);
    }
    let current;
    try {
      current = s.store.providers().find((provider) => provider.name === oldName);
    } catch {
      current = undefined;
    }
    if (!current) return fail("provider not found", 404);
    const nextName =
      typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : oldName;
    if (nextName.length > 64) return fail("name too long (max 64 chars)", 400);
    const hasApiKey = Object.prototype.hasOwnProperty.call(body, "apiKey");
    const apiKey = hasApiKey && typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const resolved = await resolveProviderBaseURL(
      typeof body.baseUrl === "string" ? body.baseUrl : current.baseUrl,
      apiKey ?? current.apiKey ?? "",
    );
    if (!resolved.ok) return fail(resolved.error, 400);
    try {
      const updated = s.store.updateProvider(oldName, {
        name: nextName,
        baseUrl: resolved.url,
        apiKey,
      });
      return json(publicProvider(updated));
    } catch (err) {
      if (err instanceof NotFoundError) return fail("provider not found", 404);
      if (err instanceof ConflictError) return fail(err.message, 409);
      return fail(err instanceof Error ? err.message : String(err), 500);
    }
  }
  if (seg[0] === "api" && seg[1] === "providers" && seg.length === 3 && method === "DELETE") {
    try {
      s.store.deleteProvider(decodeURIComponent(seg[2]!));
      return new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof NotFoundError) return fail("provider not found", 404);
      if (err instanceof ConflictError) return fail(err.message, 409);
      return fail(err instanceof Error ? err.message : String(err), 500);
    }
  }

  // ---- machines ----
  if (path === "/api/machines" && method === "GET") {
    return json(s.store.machines());
  }
  if (path === "/api/machines" && method === "POST") {
    let m: Machine;
    try {
      m = (await req.json()) as Machine;
    } catch (err) {
      return fail(String(err), 400);
    }
    if (!m.name || !m.host || !m.user) return fail("name, host, user required", 400);
    if (!m.port) m.port = 22;
    if (!m.state) m.state = "unknown";
    s.store.saveMachine(m);
    return json(m);
  }
  // host key pinning: verify and store the machine's SSH fingerprint
  if (seg[0] === "api" && seg[1] === "machines" && seg.length === 4 && seg[3] === "pin" && method === "POST") {
    const name = decodeURIComponent(seg[2]!);
    let machine: Machine;
    try {
      machine = s.store.machine(name);
    } catch {
      return fail("machine not found", 404);
    }
    if (!s.runner.pin) return fail("host key pinning not supported", 501);
    let force = false;
    try {
      const body = (await req.json()) as { force?: boolean };
      force = body?.force === true;
    } catch {
      // empty body means verify/pin without overriding an existing fingerprint
    }
    return json(await s.runner.pin(machine, { force }));
  }
  // remote self-update: the machine's kiwi downloads the latest release and
  // replaces its own binary (kiwi exec update)
  if (seg[0] === "api" && seg[1] === "machines" && seg.length === 4 && seg[3] === "update" && method === "POST") {
    const name = decodeURIComponent(seg[2]!);
    let machine: Machine;
    try {
      machine = s.store.machine(name);
    } catch {
      return fail("machine not found", 404);
    }
    // the download runs on the machine; leave room for it before the SSH abort
    const res = await s.runner.run(machine, ".", ["update"], null, AbortSignal.timeout(180_000));
    return json(res);
  }
  if (seg[0] === "api" && seg[1] === "machines" && seg.length === 3 && method === "DELETE") {
    s.store.deleteMachine(decodeURIComponent(seg[2]!));
    return new Response(null, { status: 204 });
  }

  // ---- projects ----
  if (path === "/api/projects" && method === "GET") {
    return json(s.store.projects());
  }
  if (path === "/api/projects" && method === "POST") {
    let p: Project;
    try {
      p = (await req.json()) as Project;
    } catch (err) {
      return fail(String(err), 400);
    }
    if (!p.name || !p.machine || !p.workdir) return fail("name, machine, workdir required", 400);
    try {
      const created = s.store.createProject(p);
      return json(created, 201);
    } catch (err) {
      return fail(String(err), 500);
    }
  }
  if (seg[0] === "api" && seg[1] === "projects" && seg.length === 3 && method === "DELETE") {
    const id = parseInt(seg[2]!, 10);
    if (!Number.isFinite(id) || id <= 0) return fail("bad id", 400);
    s.store.deleteProject(id);
    return new Response(null, { status: 204 });
  }

  // ---- sessions ----
  if (path === "/api/sessions" && method === "GET") {
    const project = url.searchParams.get("project");
    const projectID = project ? parseInt(project, 10) : 0;
    return json(s.store.sessions(Number.isFinite(projectID) ? projectID : 0));
  }
  if (seg[0] === "api" && seg[1] === "sessions" && seg.length === 3 && method === "PATCH") {
    let body: { name?: string };
    try {
      body = (await req.json()) as { name?: string };
    } catch {
      return fail("bad body", 400);
    }
    if (!body.name) return fail("name required", 400);
    try {
      s.store.session(decodeURIComponent(seg[2]!)); // 404 when unknown
    } catch {
      return fail("session not found", 404);
    }
    s.store.renameSession(decodeURIComponent(seg[2]!), body.name);
    return json({ name: body.name });
  }
  // ---- models & roles ----
  if (path === "/api/models" && method === "GET") {
    try {
      if (url.searchParams.get("all") === "1") {
        const refresh = url.searchParams.get("refresh") === "1";
        return json(await s.modelsForAllProviders(refresh));
      }
      const role = url.searchParams.get("role") || "agent-chat";
      const models = await s.modelsForRole(role);
      return json(models);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (seg[0] === "api" && seg[1] === "roles" && seg.length === 3 && method === "GET") {
    try {
      return json(s.store.role(decodeURIComponent(seg[2]!)));
    } catch {
      return fail("role not found", 404);
    }
  }
  if (seg[0] === "api" && seg[1] === "roles" && seg.length === 3 && method === "PUT") {
    let body: { provider?: string; model?: string };
    try {
      body = (await req.json()) as { provider?: string; model?: string };
    } catch {
      return fail("bad body", 400);
    }
    if (!body.provider || !body.model) return fail("provider, model required", 400);
    const role = decodeURIComponent(seg[2]!);
    s.store.setRole({ role, provider: body.provider, model: body.model });
    void s.refreshModelContext(role);
    return json({ provider: body.provider, model: body.model });
  }

  // ---- health ----
  // (handled at the top of this function)

  return fail("not found", 404);
}

export type { Store };
