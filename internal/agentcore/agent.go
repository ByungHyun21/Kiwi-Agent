// Package agentcore runs the server-side agent loop: system prompt, tool
// definitions, the LLM↔tool iteration, and compaction. The LLM never learns
// how tools are executed — it only sees file operations in a working folder.
package agentcore

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/ByungHyun21/Kiwi-Agent/internal/exec"
	"github.com/ByungHyun21/Kiwi-Agent/internal/llm"
	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
)

// Store persists conversation state (implemented by store.Store).
type Store interface {
	AppendMessage(sessionID string, m store.Message) error
	Messages(sessionID string) ([]store.Message, error)
	ReplaceMessages(sessionID string, msgs []store.Message) error
	AddUsage(sessionID string, prompt, completion int64) error
	Setting(key string) (string, error)
}

// Agent executes one session's turns against one project folder.
type Agent struct {
	LLM     *llm.Client
	Runner  exec.Runner
	Machine protocol.Machine
	Workdir string
	Store   Store
	Emit    func(protocol.Event)

	// MaxIterations bounds one turn's tool loop.
	MaxIterations int
}

const systemPrompt = `당신은 코딩 에이전트입니다. 도구로 작업 폴더의 파일을 만들고, 읽고, 목록합니다. 파일 경로는 작업 폴더 기준 상대 경로입니다.`

// SystemPrompt exposes the agent system prompt (used by side channels).
func SystemPrompt() string { return systemPrompt }

var agentTools = []llm.Tool{
	{
		Name:        "write_file",
		Description: "작업 폴더에 파일을 생성하거나 전체 내용을 덮어씁니다. 상대 경로를 사용하세요.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "상대 경로, 예: index.html"},
				"content": map[string]any{"type": "string", "description": "파일의 전체 새 내용"},
			},
			"required": []string{"path", "content"},
		},
	},
	{
		Name:        "read_file",
		Description: "작업 폴더의 파일 내용을 읽습니다.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string"},
			},
			"required": []string{"path"},
		},
	},
	{
		Name:        "list_dir",
		Description: "작업 폴더(또는 하위 폴더)의 항목 목록을 봅니다.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "기본값: 작업 폴더 루트"},
			},
		},
	},
}

// Turn runs one user message to completion, streaming raw events via Emit.
func (a *Agent) Turn(ctx context.Context, sessionID, userText string) error {
	if err := a.Store.AppendMessage(sessionID, store.Message{Role: "user", Content: userText}); err != nil {
		return err
	}
	maxIter := a.MaxIterations
	if maxIter <= 0 {
		maxIter = 12
	}

	sys, err := a.systemMessage(ctx)
	if err != nil {
		return err
	}
	for range maxIter {
		history, err := a.Store.Messages(sessionID)
		if err != nil {
			return err
		}
		msgs := []llm.Message{{Role: "system", Content: sys}}
		for _, m := range history {
			msg := llm.Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, Name: m.Name}
			for _, tc := range m.ToolCalls {
				msg.ToolCalls = append(msg.ToolCalls, llm.ToolCall{ID: tc.ID, Name: tc.Name, Args: tc.Args})
			}
			msgs = append(msgs, msg)
		}

		resp, err := a.LLM.StreamChat(ctx, msgs, agentTools, func(kind, name, text string) {
			switch kind {
			case "reasoning":
				a.emit(protocol.Event{Type: protocol.EvReasoning, Text: text})
			case "tool_args":
				a.emit(protocol.Event{Type: protocol.EvToolArgs, Name: name, Text: text})
			default:
				a.emit(protocol.Event{Type: protocol.EvDelta, Text: text})
			}
		})
		if err != nil {
			return err
		}
		_ = a.Store.AddUsage(sessionID, resp.Usage.PromptTokens, resp.Usage.CompletionTokens)
		a.emitState(sessionID, resp.Usage)

		stored := store.Message{Role: "assistant", Content: resp.Content}
		for _, tc := range resp.ToolCalls {
			stored.ToolCalls = append(stored.ToolCalls, store.ToolCallSt{ID: tc.ID, Name: tc.Name, Args: tc.Args})
		}
		if err := a.Store.AppendMessage(sessionID, stored); err != nil {
			return err
		}

		if len(resp.ToolCalls) == 0 {
			return nil
		}
		for _, tc := range resp.ToolCalls {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			a.emit(protocol.Event{Type: protocol.EvToolCall, Name: tc.Name, Args: tc.Args})
			result := a.runTool(ctx, tc)
			a.emit(protocol.Event{Type: protocol.EvToolResult, Name: tc.Name, Result: result})
			if err := a.Store.AppendMessage(sessionID, store.Message{
				Role: "tool", Content: result, ToolCallID: tc.ID, Name: tc.Name,
			}); err != nil {
				return err
			}
		}
	}
	return fmt.Errorf("최대 도구 반복 횟수(%d) 초과", maxIter)
}

// systemMessage combines the minimal tool-usage prompt with the project's
// AGENTS.md when present. No behavioral instructions are injected.
func (a *Agent) systemMessage(ctx context.Context) (string, error) {
	sys := systemPrompt
	res := a.Runner.Run(ctx, a.Machine, a.Workdir, []string{"read", "AGENTS.md"}, nil)
	if res.OK && strings.TrimSpace(res.Data) != "" {
		sys += "\n\n# AGENTS.md\n\n" + res.Data
	}
	return sys, nil
}

// runTool executes one tool call and returns the raw display text.
func (a *Agent) runTool(ctx context.Context, tc llm.ToolCall) string {
	var args struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(tc.Args), &args); err != nil {
		return "오류: 도구 인자가 잘못되었습니다: " + err.Error()
	}
	if !safePath(args.Path) {
		return "오류: 경로는 작업 폴더 안의 상대 경로여야 합니다: " + args.Path
	}

	switch tc.Name {
	case "write_file":
		return a.toolWrite(ctx, args.Path, args.Content)
	case "read_file":
		res := a.Runner.Run(ctx, a.Machine, a.Workdir, []string{"read", args.Path}, nil)
		if !res.OK {
			return "오류 (" + res.Code + "): " + res.Message
		}
		return res.Data
	case "list_dir":
		argv := []string{"ls"}
		if args.Path != "" {
			argv = append(argv, args.Path)
		}
		res := a.Runner.Run(ctx, a.Machine, a.Workdir, argv, nil)
		if !res.OK {
			return "오류 (" + res.Code + "): " + res.Message
		}
		return res.Data
	default:
		return "오류: 알 수 없는 도구: " + tc.Name
	}
}

func (a *Agent) toolWrite(ctx context.Context, rel, content string) string {
	old := a.Runner.Run(ctx, a.Machine, a.Workdir, []string{"read", rel}, nil)
	var oldText string
	if old.OK {
		oldText = old.Data
	}
	res := a.Runner.Run(ctx, a.Machine, a.Workdir, []string{"write", rel}, []byte(content))
	if !res.OK {
		return "오류 (" + res.Code + "): " + res.Message
	}
	if oldText == "" {
		// new file: the diff IS the full raw content
		return UnifiedDiff(rel, "", content)
	}
	return rel + " 수정됨\n" + UnifiedDiff(rel, oldText, content)
}

// safePath rejects absolute paths and traversal outside the workdir.
func safePath(p string) bool {
	if p == "" || path.IsAbs(p) || strings.HasPrefix(p, "/") {
		return false
	}
	clean := path.Clean(p)
	return clean != ".." && !strings.HasPrefix(clean, "../")
}

// Compact summarizes the session history into a single message.
func (a *Agent) Compact(ctx context.Context, sessionID string) error {
	history, err := a.Store.Messages(sessionID)
	if err != nil {
		return err
	}
	if len(history) == 0 {
		return nil
	}
	var b strings.Builder
	for _, m := range history {
		b.WriteString(m.Role + ": " + m.Content + "\n")
	}
	summary, err := a.LLM.Complete(ctx, []llm.Message{
		{Role: "system", Content: "다음 코딩 세션 기록을, 만들어진 파일과 결정된 사항을 보존하여 간결한 요약으로 만들어 주세요. 요약 본문만 출력하세요."},
		{Role: "user", Content: b.String()},
	})
	if err != nil {
		return err
	}
	return a.Store.ReplaceMessages(sessionID, []store.Message{
		{Role: "user", Content: "[지금까지 세션 요약]\n" + summary},
	})
}

func (a *Agent) emit(e protocol.Event) {
	if a.Emit != nil {
		a.Emit(e)
	}
}

func (a *Agent) emitState(sessionID string, u llm.Usage) {
	ctxMax := a.settingInt("ctx_max", 128000)
	a.emit(protocol.Event{Type: protocol.EvState, State: &protocol.PanelState{
		CtxUsed: int(u.PromptTokens + u.CompletionTokens),
		CtxMax:  ctxMax,
	}})
}

func (a *Agent) settingInt(key string, def int) int {
	v, err := a.Store.Setting(key)
	if err != nil || v == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n <= 0 {
		return def
	}
	return n
}

// ShouldCompact reports whether usage crossed the auto-compact threshold.
func (a *Agent) ShouldCompact(used, max int) bool {
	if max <= 0 {
		return false
	}
	threshold := a.settingInt("compact_threshold", 80)
	return used*100/max >= threshold
}

// UnifiedDiff renders a line diff between old and new content.
func UnifiedDiff(name, oldText, newText string) string {
	a := strings.Split(strings.TrimRight(oldText, "\n"), "\n")
	b := strings.Split(strings.TrimRight(newText, "\n"), "\n")
	var out []string
	for _, ln := range lcsDiff(a, b) {
		switch ln.op {
		case '-':
			out = append(out, "- "+ln.text)
		case '+':
			out = append(out, "+ "+ln.text)
		}
	}
	if len(out) == 0 {
		return name + " 변경 없음"
	}
	return "--- " + name + "\n+++ " + name + "\n" + strings.Join(out, "\n")
}

type diffLine struct {
	op   byte
	text string
}

// lcsDiff computes a line-level diff via LCS dynamic programming.
func lcsDiff(a, b []string) []diffLine {
	n, m := len(a), len(b)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out []diffLine
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, diffLine{'-', a[i]})
			i++
		default:
			out = append(out, diffLine{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, diffLine{'-', a[i]})
	}
	for ; j < m; j++ {
		out = append(out, diffLine{'+', b[j]})
	}
	return out
}
