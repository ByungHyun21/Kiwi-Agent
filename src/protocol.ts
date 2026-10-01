// Shared contracts between kiwi-server, the kiwi TUI and the kiwi exec
// subcommand: the exec JSON result and the WebSocket event stream.

/** ExecResult is the single JSON document every `kiwi exec` command prints on stdout. */
export interface ExecResult {
  ok: boolean;
  code?: string; // noent | denied | badrequest | conflict | timeout | error
  message?: string; // human-readable detail
  data?: string; // payload: file content, listing, sha, info JSON
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
  updatedAt?: Date;
}

/** PanelState carries the live sidebar values. */
export interface PanelState {
  project: string;
  machine: string;
  model: string;
  goal: string;
  todos?: string[];
  ctxUsed: number;
  ctxMax: number;
  tokens: number; // cumulative session tokens
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

/** ClientMsg is a client→server WS message. */
export interface ClientMsg {
  type: string;
  text?: string;
  sessionId?: string;
  projectId?: string;
}
