// kiwi-server wire protocol (client copy of src/protocol.ts).

export const EvHello = "hello";
export const EvDelta = "delta";
export const EvReasoning = "reasoning";
export const EvToolCall = "tool_call";
export const EvToolArgs = "tool_args";
export const EvToolResult = "tool_result";
export const EvDone = "done";
export const EvError = "error";
export const EvStatus = "status";
export const EvSessions = "sessions";
export const EvState = "state";
export const EvHistory = "history";

export const MsgSend = "send";
export const MsgStop = "stop";
export const MsgSessions = "sessions";
export const MsgState = "state";
export const MsgNew = "new";
export const MsgResume = "resume";
export const MsgProject = "project";
export const MsgCompact = "compact";
export const MsgSetGoal = "set_goal";

export interface PanelState {
  project: string;
  machine: string;
  model: string;
  goal: string;
  todos?: string[];
  ctxUsed: number;
  ctxMax: number;
  tokens: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  goal?: string;
}

export interface HistoryEntry {
  kind: string; // user | assistant | tool | result | notice
  text: string;
}

export interface Event {
  type: string;
  session?: string;
  text?: string;
  name?: string;
  args?: string;
  result?: string;
  error?: string;
  sessions?: SessionInfo[];
  state?: PanelState;
  history?: HistoryEntry[];
}

export interface ClientMsg {
  type: string;
  text?: string;
  sessionId?: string;
}

export interface Project {
  id: number;
  name: string;
  machine: string;
  workdir: string;
}

/** wsURL builds ws://host/ws?token=... from a host:port or URL. */
export function wsURL(host: string, token: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export async function getJSON<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(path, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000),
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

export async function postJSON(path: string, token: string, body?: unknown): Promise<void> {
  const resp = await fetch(path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
}
