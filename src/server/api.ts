// REST API guarded by the bearer token.

import type { Machine, Project } from "../protocol.ts";
import { Store } from "../store.ts";
import type { KiwiServer } from "./server.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v) + "\n", { status, headers: jsonHeaders });
}

function fail(msg: string, status: number): Response {
  return new Response(msg + "\n", { status });
}

function bearerToken(req: Request, url: URL): string {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return url.searchParams.get("token") ?? "";
}

/** apiRoutes dispatches /api/* requests. */
export async function apiRoutes(s: KiwiServer, req: Request, url: URL): Promise<Response> {
  // health is public (parity with the Go server)
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json({ status: "ok" });
  }

  // auth guard
  if (bearerToken(req, url) !== s.token) {
    return fail("unauthorized", 401);
  }

  const path = url.pathname;
  const method = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]

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
  if (path === "/api/usage" && method === "GET") {
    const id = url.searchParams.get("session") ?? "";
    if (!id) return fail("session required", 400);
    let sess;
    try {
      sess = s.store.session(id);
    } catch {
      return fail("session not found", 404);
    }
    return json({
      promptTokens: sess.promptTokens,
      completionTokens: sess.completionTokens,
      totalTokens: sess.promptTokens + sess.completionTokens,
    });
  }

  // ---- models & roles ----
  if (path === "/api/models" && method === "GET") {
    const role = url.searchParams.get("role") || "agent-chat";
    try {
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
    return json({ provider: body.provider, model: body.model });
  }

  // ---- health ----
  // (handled above, before the auth guard)

  return fail("not found", 404);
}

export type { Store };
