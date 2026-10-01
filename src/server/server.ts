// Hosts the kiwi HTTP surface: the web UI, REST API and the agent
// WebSocket endpoint.

import { Agent } from "../agent.ts";
import { Client as LLMClient } from "../llm.ts";
import type { Machine, PanelState } from "../protocol.ts";
import type { Runner } from "../ssh.ts";
import { Store } from "../store.ts";
import {
  dashboardPage,
  machinesPage,
  docsPage,
  settingsPage,
} from "../web/html.ts";
import { serveStatic } from "../web/static.ts";
import { apiRoutes } from "./api.ts";
import { projectDetail, projectsPage, sessionDetail } from "./pages.ts";
import { Conn } from "./ws.ts";

/** Server assembles all kiwi-server handlers. */
export class KiwiServer {
  store: Store;
  token: string;
  runner: Runner;

  constructor(store: Store, runner: Runner) {
    this.store = store;
    this.token = store.token();
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
    let machine: Machine;
    try {
      machine = this.store.machine(project.machine);
    } catch {
      throw new Error("기기를 찾을 수 없습니다");
    }
    const client = this.llmForRole("agent-chat");
    return new Agent({ llm: client, runner: this.runner, machine, workdir: project.workdir, store: this.store });
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
      state.machine = p.machine;
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
