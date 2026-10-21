// Hosts the kiwi HTTP surface: the web UI, REST API and the agent
// WebSocket endpoint.

import { Agent } from "../agent.ts";
import { Client as LLMClient } from "../llm.ts";
import type { Machine, PanelState } from "../protocol.ts";
import type { Runner } from "../ssh.ts";
import { Store } from "../store.ts";
import {
  chatPage,
  dashboardPage,
  machinesPage,
  docsPage,
  settingsPage,
} from "../web/html.ts";
import { serveStatic } from "../web/static.ts";
import { apiRoutes } from "./api.ts";
import { serveWebDist } from "./webdist.ts";
import { projectDetail, projectsPage, sessionDetail } from "./pages.ts";
import { Conn } from "./ws.ts";

/** Server assembles all kiwi-server handlers. */
export class KiwiServer {
  store: Store;
  token: string;
  webDist: string;
  runner: Runner;

  constructor(store: Store, runner: Runner) {
    this.store = store;
    this.token = store.token();
    this.webDist = process.env.KIWI_WEB_DIST ?? "";
    this.runner = runner;
  }

  /** Handle one HTTP request (routing, shared by REST/pages/WS upgrade). */
  async handle(
    req: Request,
    server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
  ): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // websocket endpoint
    if (path === "/ws") {
      let token = url.searchParams.get("token") ?? "";
      if (!token) {
        token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      }
      if (token !== this.token) {
        return new Response("unauthorized", { status: 401 });
      }
      const upgraded = server.upgrade(req, { data: new Conn(this) });
      if (upgraded) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 500 });
    }

    // built web SPA (KIWI_WEB_DIST) — serves assets and falls back to
    // index.html for app routes; legacy htmx pages keep their exact paths
    if (this.webDist !== "" && !path.startsWith("/api") && !path.startsWith("/static") && path !== "/docs" && path !== "/settings" && path !== "/machines" && !path.startsWith("/projects") && path !== "/chat") {
      const res = await serveWebDist(this.webDist, path);
      if (res) return res;
    }

    // static assets
    if (path.startsWith("/static/")) {
      const res = serveStatic(path.slice("/static/".length));
      if (res) return res;
      return new Response("not found", { status: 404 });
    }

    // REST API
    if (path.startsWith("/api/")) {
      return apiRoutes(this, req, url);
    }

    // pages
    if (req.method === "GET") {
      switch (path) {
        case "/":
          return html(dashboardPage());
        case "/machines":
          return html(machinesPage(this.store.machines()));
        case "/projects":
          return projectsPage(this);
        case "/settings": {
          let provider = "", baseURL = "", model = "";
          try {
            const role = this.store.role("agent-chat");
            provider = role.provider;
            model = role.model;
            for (const p of this.store.providers()) {
              if (p.name === provider) baseURL = p.baseUrl;
            }
          } catch {
            // not configured yet
          }
          return html(settingsPage(this.token, provider, baseURL, model));
        }
        case "/chat":
          return html(chatPage(this.token));
        case "/docs":
          return html(docsPage());
      }
      if (path.startsWith("/projects/")) {
        return projectDetail(this, path.slice("/projects/".length));
      }
      if (path.startsWith("/sessions/")) {
        return sessionDetail(this, decodeURIComponent(path.slice("/sessions/".length)));
      }
    }

    return new Response("not found", { status: 404 });
  }

  /** agentFor builds the agent runtime for a session's project. */
  agentFor(sessionID: string): Agent {
    let sess;
    try {
      sess = this.store.session(sessionID);
    } catch {
      throw new Error("세션을 찾을 수 없습니다");
    }
    let project;
    try {
      project = this.store.project(sess.projectId);
    } catch {
      throw new Error("프로젝트를 찾을 수 없습니다");
    }
    const loc = this.execFor(sessionID, project.id);
    const client = this.llmForRole("agent-chat");
    return new Agent({ llm: client, runner: this.runner, machine: loc.machine, workdir: loc.workdir, store: this.store });
  }

  /** execFor resolves a session's machine/workdir with project fallback (T01). */
  execFor(sessionID: string, projectId: number): { machine: Machine; workdir: string } {
    let machineName = "";
    let workdir = "";
    if (sessionID !== "") {
      const loc = this.store.sessionLocation(sessionID);
      machineName = loc.machine;
      workdir = loc.workdir;
    }
    const project = this.store.project(projectId);
    if (machineName === "") machineName = project.machine;
    if (workdir === "") workdir = project.workdir;
    try {
      return { machine: this.store.machine(machineName), workdir };
    } catch {
      throw new Error("기기를 찾을 수 없습니다");
    }
  }

  /** llmForRole resolves a role to a provider client. */
  llmForRole(role: string): LLMClient {
    let r;
    try {
      r = this.store.role(role);
    } catch {
      throw new Error(`역할 ${role} 이 설정되지 않았습니다 (웹UI 설정 확인)`);
    }
    for (const p of this.store.providers()) {
      if (p.name === r.provider) {
        return new LLMClient(p.baseUrl, p.apiKey ?? "", r.model);
      }
    }
    throw new Error(`공급자 ${r.provider} 를 찾을 수 없습니다`);
  }

  /** modelsForRole lists models of the provider behind a role. */
  async modelsForRole(role: string): Promise<string[]> {
    const client = this.llmForRole(role);
    return client.listModels();
  }

  /** panelState assembles the live sidebar state for a session. */
  panelState(sessionID: string, projectName: string): PanelState {
    const state: PanelState = { project: projectName, machine: "", model: "", goal: "", ctxUsed: 0, ctxMax: 128000, tokens: 0 };
    try {
      state.model = this.store.role("agent-chat").model;
    } catch {
      // unconfigured
    }
    const ctxMax = parseInt(this.store.setting("ctx_max"), 10);
    if (Number.isFinite(ctxMax) && ctxMax > 0) state.ctxMax = ctxMax;
    if (sessionID === "") return state;
    let sess;
    try {
      sess = this.store.session(sessionID);
    } catch {
      return state;
    }
    state.goal = sess.goal;
    state.tokens = sess.promptTokens + sess.completionTokens;
    try {
      const p = this.store.project(sess.projectId);
      state.project = p.name;
      const loc = this.store.sessionLocation(sessionID);
      state.machine = loc.machine || p.machine;
    } catch {
      // ignore
    }
    if (sess.promptTokens + sess.completionTokens > 0) {
      state.ctxUsed = Math.min(sess.promptTokens + sess.completionTokens, state.ctxMax);
    }
    return state;
  }
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
