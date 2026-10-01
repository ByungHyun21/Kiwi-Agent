// Connection to kiwi-server: WebSocket events and REST helpers.

import type { ClientMsg, Event, Machine, Project, SessionInfo } from "../protocol.ts";
import type { Cmd } from "./term.ts";

/** App messages produced by the network layer. */
export interface ConnectResultMsg {
  t: "connectResult";
  client?: WSClient;
  err?: Error;
}
export interface RoleMsg {
  t: "role";
  provider: string;
  model: string;
  err?: Error;
}
export interface SessionsForProjectMsg {
  t: "sessionsForProject";
  sessions: SessionInfo[];
  err?: Error;
}
export interface ProjectsMsg {
  t: "projects";
  list: Project[];
  err?: Error;
}
export interface ModelsMsg {
  t: "models";
  list: string[];
  err?: Error;
}
export interface MachinesMsg {
  t: "machines";
  list: Machine[];
  err?: Error;
}
export interface UsageMsg {
  t: "usage";
  prompt: number;
  completion: number;
  err?: Error;
}
export interface ActionDoneMsg {
  t: "actionDone";
  err?: Error;
}

export type NetMsg =
  | ConnectResultMsg
  | RoleMsg
  | SessionsForProjectMsg
  | ProjectsMsg
  | ModelsMsg
  | MachinesMsg
  | UsageMsg
  | ActionDoneMsg
  | { t: "wsEvent"; ev: Event }
  | { t: "wsClosed" };

/** wsClient is the connection to kiwi-server. */
export class WSClient {
  private ws: WebSocket;
  /** onEvent is invoked for every server event. */
  onEvent: (ev: Event) => void = () => {};
  /** onClose is invoked when the connection drops. */
  onClose: () => void = () => {};

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(String(e.data)) as Event;
        this.onEvent(ev);
      } catch {
        // ignore malformed events
      }
    };
    ws.onclose = () => {
      this.onClose();
    };
  }

  /** dial connects to ws://addr/ws?token=... */
  static dial(addr: string, token: string): Promise<WSClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsURL(addr, token));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("연결 시간 초과"));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new WSClient(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("서버에 연결할 수 없습니다"));
      };
    });
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    this.ws.send(JSON.stringify(m));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export function wsURL(addr: string, token: string): string {
  let a = addr;
  if (!a.includes("://")) a = "ws://" + a;
  const u = new URL(a);
  u.pathname = "/ws";
  u.search = "token=" + encodeURIComponent(token);
  return u.toString();
}

export function restURL(addr: string, p: string): string {
  let a = addr;
  if (a.includes("://")) {
    a = a.replace(/^ws:\/\//, "").replace(/^http:\/\//, "");
  }
  return "http://" + a.replace(/\/$/, "") + p;
}

export async function getJSON<T>(u: string, token: string): Promise<T> {
  const resp = await fetch(u, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(5000),
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

export async function postJSON(method: string, u: string, token: string, body?: unknown): Promise<void> {
  const resp = await fetch(u, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
}

// ---- network commands (each resolves to a NetMsg) ----

export function dialServer(addr: string, token: string): Cmd {
  return WSClient.dial(addr, token).then(
    (client) => ({ t: "connectResult", client }) satisfies ConnectResultMsg,
    (err: unknown) => ({ t: "connectResult", err: err instanceof Error ? err : new Error(String(err)) }) satisfies ConnectResultMsg,
  );
}

export function fetchRole(addr: string, token: string): Cmd {
  return getJSON<{ provider?: string; model?: string }>(restURL(addr, "/api/roles/agent-chat"), token).then(
    (out) => ({ t: "role", provider: out.provider ?? "", model: out.model ?? "" }) satisfies RoleMsg,
    (err: unknown) => ({ t: "role", provider: "", model: "", err: toErr(err) }) satisfies RoleMsg,
  );
}

/** fetchSessionsForProject lists sessions of a project by name. */
export function fetchSessionsForProject(addr: string, token: string, projectName: string): Promise<unknown> {
  return (async (): Promise<unknown> => {
    let projects: Project[];
    try {
      projects = await getJSON<Project[]>(restURL(addr, "/api/projects"), token);
    } catch (err) {
      return { t: "sessionsForProject", sessions: [], err: toErr(err) } satisfies SessionsForProjectMsg;
    }
    for (const p of projects) {
      if (p.name !== projectName) continue;
      try {
        const sessions = await getJSON<SessionInfo[]>(restURL(addr, `/api/sessions?project=${encodeURIComponent(String(p.id))}`), token);
        return { t: "sessionsForProject", sessions } satisfies SessionsForProjectMsg;
      } catch (err) {
        return { t: "sessionsForProject", sessions: [], err: toErr(err) } satisfies SessionsForProjectMsg;
      }
    }
    return { t: "sessionsForProject", sessions: [], err: new Error(`프로젝트를 찾을 수 없습니다: ${projectName}`) } satisfies SessionsForProjectMsg;
  })();
}

export function fetchProjects(addr: string, token: string): Cmd {
  return getJSON<Project[]>(restURL(addr, "/api/projects"), token).then(
    (list) => ({ t: "projects", list }) satisfies ProjectsMsg,
    (err: unknown) => ({ t: "projects", list: [], err: toErr(err) }) satisfies ProjectsMsg,
  );
}

export function fetchModels(addr: string, token: string): Cmd {
  return getJSON<string[]>(restURL(addr, "/api/models"), token).then(
    (list) => ({ t: "models", list }) satisfies ModelsMsg,
    (err: unknown) => ({ t: "models", list: [], err: toErr(err) }) satisfies ModelsMsg,
  );
}

export function fetchMachines(addr: string, token: string): Cmd {
  return getJSON<Machine[]>(restURL(addr, "/api/machines"), token).then(
    (list) => ({ t: "machines", list }) satisfies MachinesMsg,
    (err: unknown) => ({ t: "machines", list: [], err: toErr(err) }) satisfies MachinesMsg,
  );
}

export function fetchUsage(addr: string, token: string, sessionID: string): Cmd {
  return getJSON<{ promptTokens?: number; completionTokens?: number }>(
    restURL(addr, `/api/usage?session=${encodeURIComponent(sessionID)}`),
    token,
  ).then(
    (out) => ({ t: "usage", prompt: out.promptTokens ?? 0, completion: out.completionTokens ?? 0 }) satisfies UsageMsg,
    (err: unknown) => ({ t: "usage", prompt: 0, completion: 0, err: toErr(err) }) satisfies UsageMsg,
  );
}

export function sendCmd(c: WSClient | null, m: ClientMsg): Cmd {
  if (!c) return null;
  return (async (): Promise<unknown> => {
    try {
      c.send(m);
      return null;
    } catch (err) {
      return { t: "wsEvent", ev: { type: "error", error: err instanceof Error ? err.message : String(err) } };
    }
  })();
}

function toErr(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
