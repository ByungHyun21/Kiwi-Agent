// Shared contracts between kiwi-server, the web client and the kiwi exec
// subcommand: the exec JSON result, stored entities, and the WebSocket
// event stream. This file is the single source of truth for the wire
// protocol — the web SPA imports it directly.

/** ExecResult is the single JSON document every `kiwi exec` command prints on stdout. */
export interface ExecResult {
  ok: boolean;
  code?: string; // noent | denied | badrequest | conflict | timeout | error
  message?: string; // human-readable detail
  data?: string; // payload: file content, listing, sha, info JSON
}

/** ProviderInfo is a registered OpenAI-compatible endpoint (API key masked). */
export interface ProviderInfo {
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
}

/** ProviderModelGroup is the model list discovered from one provider. */
export interface ProviderModelGroup {
  provider: string;
  models: string[];
  error?: string;
}

/** Machine describes a registered work machine. */
export interface Machine {
  name: string;
  host: string;
  port: number;
  user: string;
  execPath?: string; // default ~/.local/bin/kiwi
  hostKey?: string; // TOFU fingerprint
  state: string;
  lastSeen?: Date;
}

/** Project maps to one folder on one machine. */
export interface Project {
  id: number;
  name: string;
  machine: string;
  workdir: string;
}

/** SessionInfo is a session list entry sent to the TUI. */
export interface SessionInfo {
  id: string;
  name: string;
  project?: string;
  workdir?: string; // session's own workdir (T01); last segment shown in lists
  updatedAt?: Date;
}

/** ThinkLevel is the per-session reasoning setting. */
export const THINK_LEVELS = ["auto", "off", "on", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

/** isThinkLevel validates a reasoning level received from the wire. */
export function isThinkLevel(value: unknown): value is ThinkLevel {
  return typeof value === "string" && (THINK_LEVELS as readonly string[]).includes(value);
}

/** RoleInfo is the provider/model routing for one role. */
export interface RoleInfo {
  role: string;
  provider: string;
  model: string;
}

/** PanelState carries the live sidebar values. */
export interface PanelState {
  project: string;
  machine: string;
  model: string;
  goal: string;
  todos?: string[];
  ctxUsed: number; // current session context tokens
  ctxMax: number; // model context window
  think: ThinkLevel; // current session reasoning setting
}

// Server→client WS event types.
export const EvHello = "hello"; // connection accepted
export const EvDelta = "delta"; // assistant content chunk (raw)
export const EvReasoning = "reasoning"; // thinking content chunk (raw)
export const EvToolCall = "tool_call"; // tool name + raw args
export const EvToolArgs = "tool_args"; // streaming chunk of tool arguments
export const EvToolResult = "tool_result"; // raw tool output
export const EvDone = "done"; // turn finished
export const EvError = "error";
export const EvStatus = "status"; // working | idle
export const EvSessions = "sessions";
export const EvState = "state";
export const EvHistory = "history"; // replay of a resumed session
export const EvCat = "cat"; // /cat viewer content
export const EvPathComplete = "path_complete"; // tab-completion candidates
export const EvBtwSides = "btw_sides"; // retained btw sides of the current session
export const EvNotice = "notice"; // transient one-line system notice (not stored)

/** HistoryEntry is one replayed transcript entry for a resumed session. */
export interface HistoryEntry {
  kind: string; // user | assistant | tool | result | notice
  text: string;
}

/** Event is a server→client WS message. */
export interface Event {
  type: string;
  session?: string; // current session id
  text?: string;
  name?: string; // tool name, status value
  args?: string; // raw tool arguments
  result?: string; // raw tool output
  error?: string;
  sessions?: SessionInfo[];
  state?: PanelState;
  history?: HistoryEntry[];
  candidates?: string[]; // path completion candidates
}

// Client→server WS message types.
export const MsgSend = "send";
export const MsgStop = "stop";
export const MsgSessions = "sessions";
export const MsgState = "state";
export const MsgNew = "new";
export const MsgResume = "resume";
export const MsgSetGoal = "set_goal";
export const MsgProject = "project";
export const MsgCompact = "compact";
export const MsgBtw = "btw";
export const MsgBtwSides = "btw_sides";
export const MsgSessionCd = "session_cd";
export const MsgSessionHost = "session_host";
export const MsgCat = "cat";
export const MsgPathComplete = "path_complete";
export const MsgSetThink = "set_think";

/** ClientMsg is a client→server WS message. */
export interface ClientMsg {
  type: string;
  text?: string;
  sessionId?: string;
  projectId?: string;
}
