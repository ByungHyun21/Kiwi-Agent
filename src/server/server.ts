// Hosts the kiwi HTTP surface: the web SPA, REST API and the agent
// WebSocket endpoint.

import { Agent } from "./agent/loop.ts";
import { cachedModelContext, Client as LLMClient } from "../llm.ts";
import type { Machine, PanelState, ProviderModelGroup } from "../shared/protocol.ts";
import type { Runner } from "../ssh.ts";
import { Store } from "../store.ts";
import { apiRoutes } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import { serveWebDist } from "./webdist.ts";
import { Conn } from "./ws.ts";

/** Server assembles all kiwi-server handlers. */
export class KiwiServer {
  store: Store;
  webDist: string;
  runner: Runner;
  private envSearxngUrl: string;

  constructor(store: Store, runner: Runner, config: ServerConfig) {
    this.store = store;
    this.webDist = config.webDist;
    this.runner = runner;
    this.envSearxngUrl = config.searxngUrl;
  }

  /** searchURL resolves the runtime SearXNG base (web setting wins over env). */
  searchURL(): string {
    const saved = this.store.setting("searxng_url").trim();
    return saved !== "" ? saved : this.envSearxngUrl;
  }

  /** searchSource reports where the effective SearXNG URL comes from. */
  searchSource(): "web" | "env" | "none" {
    if (this.store.setting("searxng_url").trim() !== "") return "web";
    return this.envSearxngUrl !== "" ? "env" : "none";
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
    return new Agent({
      llm: client,
      runner: this.runner,
      machine: loc.machine,
      workdir: loc.workdir,
      store: this.store,
      searxngUrl: this.searchURL(),
      think: sess.think,
    });
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

  /** modelsForAllProviders discovers models from every registered provider. */
  async modelsForAllProviders(refresh = false): Promise<ProviderModelGroup[]> {
    const out: ProviderModelGroup[] = [];
    for (const provider of this.store.providers()) {
      const client = new LLMClient(provider.baseUrl, provider.apiKey ?? "", "");
      try {
        const models = await client.listModels(AbortSignal.timeout(8_000), refresh);
        out.push({ provider: provider.name, models });
      } catch (err) {
        out.push({
          provider: provider.name,
          models: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /** refreshModelContext loads /models so the panel can show the model context window. */
  async refreshModelContext(role = "agent-chat"): Promise<void> {
    try {
      await this.llmForRole(role).listModelInfo();
    } catch {
      // provider offline: keep the ctx_max fallback for now
    }
  }

  /** modelContextForRole returns the cached model window, 0 when unknown. */
  private modelContextForRole(role: string): number {
    try {
      const r = this.store.role(role);
      for (const p of this.store.providers()) {
        if (p.name !== r.provider) continue;
        const n = cachedModelContext(p.baseUrl, r.model);
        if (n > 0) return n;
      }
    } catch {
      // unconfigured
    }
    return 0;
  }

  /** panelState assembles the live sidebar state for a session. */
  panelState(sessionID: string, projectName: string): PanelState {
    const state: PanelState = {
      project: projectName,
      machine: "",
      model: "",
      goal: "",
      ctxUsed: 0,
      ctxMax: 128000,
      think: "auto",
    };
    try {
      state.model = this.store.role("agent-chat").model;
    } catch {
      // unconfigured
    }
    const modelCtx = this.modelContextForRole("agent-chat");
    if (modelCtx > 0) {
      state.ctxMax = modelCtx;
    } else {
      const fallback = parseInt(this.store.setting("ctx_max"), 10);
      if (Number.isFinite(fallback) && fallback > 0) state.ctxMax = fallback;
    }
    if (sessionID === "") return state;
    let sess;
    try {
      sess = this.store.session(sessionID);
    } catch {
      return state;
    }
    state.goal = sess.goal;
    state.ctxUsed = sess.ctxTokens;
    state.think = sess.think;
    try {
      const p = this.store.project(sess.projectId);
      state.project = p.name;
      const loc = this.store.sessionLocation(sessionID);
      state.machine = loc.machine || p.machine;
    } catch {
      // ignore
    }
    return state;
  }
}
