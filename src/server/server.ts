// Hosts the kiwi HTTP surface: the web SPA, REST API and the agent
// WebSocket endpoint.

import { Agent } from "./agent/loop.ts";
import { Client as LLMClient } from "../llm.ts";
import type { Machine, PanelState } from "../shared/protocol.ts";
import type { Runner } from "../ssh.ts";
import { Store } from "../store.ts";
import { apiRoutes } from "./api.ts";
import { isAuthorized } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { serveWebDist } from "./webdist.ts";
import { Conn } from "./ws.ts";

/** Server assembles all kiwi-server handlers. */
export class KiwiServer {
  store: Store;
  token: string;
  webDist: string;
  runner: Runner;
  authRequired: boolean;

  constructor(store: Store, runner: Runner, config: ServerConfig) {
    this.store = store;
    this.token = store.token();
    this.webDist = config.webDist;
    this.authRequired = config.authRequired;
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
      if (!isAuthorized(this, req, url)) {
        return new Response("unauthorized", { status: 401 });
      }
      const upgraded = server.upgrade(req, { data: new Conn(this) });
      if (upgraded) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 500 });
    }

    // REST API
    if (path.startsWith("/api/")) {
      return apiRoutes(this, req, url);
    }

    // built web SPA: assets, with index.html fallback for app routes
    if (this.webDist !== "") {
      const res = await serveWebDist(this.webDist, path);
      if (res) return res;
    }

    if (req.method === "GET") {
      return new Response("web app not built — run `bun run build` in web/ or set KIWI_WEB_DIST", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
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
