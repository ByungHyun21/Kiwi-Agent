// Package protocol defines the contracts shared by kiwi-server, the kiwi
// TUI and the kiwi exec subcommand: the exec JSON result and the WebSocket
// event stream.
package protocol

import "time"

// ExecResult is the single JSON document every `kiwi exec` command prints
// on stdout, success or failure.
type ExecResult struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"`    // noent | denied | badrequest | conflict | timeout | error
	Message string `json:"message,omitempty"` // human-readable detail
	Data    string `json:"data,omitempty"`    // payload: file content, listing, sha, info JSON
}

// Machine describes a registered work machine.
type Machine struct {
	Name     string    `json:"name"`
	Host     string    `json:"host"`
	Port     int       `json:"port"`
	User     string    `json:"user"`
	ExecPath string    `json:"execPath,omitempty"` // default ~/.local/bin/kiwi
	HostKey  string    `json:"hostKey,omitempty"`  // TOFU fingerprint
	State    string    `json:"state"`
	LastSeen time.Time `json:"lastSeen,omitempty"`
}

// Project maps to one folder on one machine.
type Project struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Machine string `json:"machine"`
	Workdir string `json:"workdir"`
}

// SessionInfo is a session list entry sent to the TUI.
type SessionInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Project   string    `json:"project,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

// PanelState carries the live sidebar values.
type PanelState struct {
	Project string   `json:"project"`
	Machine string   `json:"machine"`
	Model   string   `json:"model"`
	Goal    string   `json:"goal"`
	Todos   []string `json:"todos,omitempty"`
	CtxUsed int      `json:"ctxUsed"`
	CtxMax  int      `json:"ctxMax"`
	Tokens  int      `json:"tokens"` // cumulative session tokens
}

// Server→client WS event types.
const (
	EvHello      = "hello"       // connection accepted
	EvDelta      = "delta"       // assistant content chunk (raw)
	EvReasoning  = "reasoning"   // thinking content chunk (raw)
	EvToolCall   = "tool_call"   // tool name + raw args
	EvToolResult = "tool_result" // raw tool output
	EvDone       = "done"        // turn finished
	EvError      = "error"
	EvStatus     = "status" // working | idle
	EvSessions   = "sessions"
	EvState      = "state"
)

// Event is a server→client WS message.
type Event struct {
	Type     string        `json:"type"`
	Session  string        `json:"session,omitempty"` // current session id
	Text     string        `json:"text,omitempty"`
	Name     string        `json:"name,omitempty"`   // tool name, status value
	Args     string        `json:"args,omitempty"`   // raw tool arguments
	Result   string        `json:"result,omitempty"` // raw tool output
	Error    string        `json:"error,omitempty"`
	Sessions []SessionInfo `json:"sessions,omitempty"`
	State    *PanelState   `json:"state,omitempty"`
}

// Client→server WS message types.
const (
	MsgSend     = "send"
	MsgStop     = "stop"
	MsgSessions = "sessions"
	MsgState    = "state"
	MsgNew      = "new"
	MsgResume   = "resume"
	MsgSetGoal  = "set_goal"
	MsgProject  = "project"
	MsgCompact  = "compact"
	MsgBtw      = "btw"
)

// ClientMsg is a client→server WS message.
type ClientMsg struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
}
