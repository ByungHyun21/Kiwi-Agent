package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// lineKind marks one transcript entry for visual separation.
type lineKind int

const (
	lineUser lineKind = iota
	lineAssistant
	lineReasoning
	lineTool
	lineResult
	lineError
	lineNotice
)

type tline struct {
	kind lineKind
	text string
}

var (
	userStyle      = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#e8eadf"))
	reasoningStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#7d8377"))
	toolStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("#a8c17a")).Bold(true)
	resultStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#b9b39f"))
	errStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("#d98a4a")).Bold(true)
	noticeStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#8fce5a"))
)

func (k lineKind) marker() string {
	switch k {
	case lineUser:
		return "▶ "
	case lineReasoning:
		return "· "
	case lineTool:
		return "⚒ "
	case lineResult:
		return "│ "
	case lineError:
		return "✗ "
	case lineNotice:
		return "◆ "
	}
	return ""
}

func (k lineKind) style() lipgloss.Style {
	switch k {
	case lineUser:
		return userStyle
	case lineReasoning:
		return reasoningStyle
	case lineTool:
		return toolStyle
	case lineResult:
		return resultStyle
	case lineError:
		return errStyle
	case lineNotice:
		return noticeStyle
	}
	return lipgloss.NewStyle()
}

// applyEvent folds one server event into the transcript.
func (m *Model) applyEvent(ev protocol.Event) {
	switch ev.Type {
	case protocol.EvDelta:
		m.appendStream(lineAssistant, ev.Text)
	case protocol.EvReasoning:
		m.appendStream(lineReasoning, ev.Text)
	case protocol.EvToolCall:
		args := ev.Args
		if len(args) > 120 {
			args = args[:120] + "…"
		}
		m.transcript = append(m.transcript, tline{lineTool, ev.Name + " " + args})
		m.streamKind = -1
	case protocol.EvToolResult:
		m.transcript = append(m.transcript, tline{lineResult, ev.Result})
		m.streamKind = -1
	case protocol.EvError:
		m.transcript = append(m.transcript, tline{lineError, ev.Error})
		m.streamKind = -1
	case protocol.EvStatus:
		m.busy = ev.Name == "working"
		if ev.Name != "working" && ev.Name != "idle" {
			m.transcript = append(m.transcript, tline{lineNotice, statusText(ev.Name)})
		}
		m.streamKind = -1
	case protocol.EvDone:
		m.streamKind = -1
	case protocol.EvState:
		if ev.Session != "" {
			m.currentSession = ev.Session
		}
		if ev.State != nil {
			m.project = ev.State.Project
			m.machine = ev.State.Machine
			m.model = ev.State.Model
			m.goal = ev.State.Goal
			m.ctxUsed = ev.State.CtxUsed
			m.ctxMax = ev.State.CtxMax
			if ev.State.Tokens > 0 {
				m.tokens = ev.State.Tokens
			}
		}
	case protocol.EvSessions:
		m.sessions = nil
		for _, s := range ev.Sessions {
			m.sessions = append(m.sessions, s.Name)
		}
		m.sessionIDs = ev.Sessions
	}
}

// appendStream continues the last line of the same kind or starts a new one.
func (m *Model) appendStream(kind lineKind, text string) {
	if m.streamKind == int(kind) && len(m.transcript) > 0 {
		last := &m.transcript[len(m.transcript)-1]
		last.text += text
		return
	}
	m.transcript = append(m.transcript, tline{kind, text})
	m.streamKind = int(kind)
}

func statusText(name string) string {
	switch name {
	case "queued":
		return "작업 중이라 대기열에 추가했습니다"
	case "stopped":
		return "작업을 중단했습니다"
	case "compacted":
		return "컨텍스트를 압축했습니다"
	}
	return name
}

// renderTranscript renders wrapped transcript lines, tail-fitted to height.
func (m Model) renderTranscript(width, height int) string {
	if height <= 0 {
		return ""
	}
	// wrap every line to width
	var lines []string
	for _, ln := range m.transcript {
		st := ln.kind.style()
		marker := ln.kind.marker()
		if ln.text == "" {
			lines = append(lines, "")
			continue
		}
		// lipgloss wraps by display cells (CJK-aware), unlike rune counting
		wrapped := st.Width(width).Render(marker + strings.TrimRight(ln.text, "\n"))
		lines = append(lines, wrapped)
		// blank line between entries for visual separation
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[len(lines)-height:]
	}
	for len(lines) < height {
		lines = append([]string{""}, lines...)
	}
	return strings.Join(lines, "\n")
}
