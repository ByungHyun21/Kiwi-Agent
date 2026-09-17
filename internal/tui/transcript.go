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

	wrapped   []string // display lines, cached
	wrapWidth int      // width the cache was built for
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

// displayLines returns the wrapped display lines for one entry, using and
// maintaining a per-entry cache so streaming deltas only re-wrap the
// growing line instead of the whole transcript.
func (ln *tline) displayLines(width int) []string {
	if ln.wrapped != nil && ln.wrapWidth == width {
		return ln.wrapped
	}
	if ln.text == "" {
		ln.wrapped, ln.wrapWidth = []string{""}, width
		return ln.wrapped
	}
	block := ln.kind.style().Width(width).Render(ln.kind.marker() + strings.TrimRight(ln.text, "\n"))
	ln.wrapped, ln.wrapWidth = strings.Split(block, "\n"), width
	return ln.wrapped
}

// invalidate drops the wrap cache (text changed).
func (ln *tline) invalidate() {
	ln.wrapped, ln.wrapWidth = nil, 0
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
		m.transcript = append(m.transcript, tline{lineTool, ev.Name + " " + args, nil, 0})
		m.streamKind = -1
	case protocol.EvToolResult:
		m.transcript = append(m.transcript, tline{lineResult, ev.Result, nil, 0})
		m.streamKind = -1
	case protocol.EvError:
		m.transcript = append(m.transcript, tline{lineError, ev.Error, nil, 0})
		m.streamKind = -1
	case protocol.EvStatus:
		m.busy = ev.Name == "working"
		if ev.Name != "working" && ev.Name != "idle" {
			m.transcript = append(m.transcript, tline{lineNotice, statusText(ev.Name), nil, 0})
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
		last.invalidate()
		return
	}
	m.transcript = append(m.transcript, tline{kind, text, nil, 0})
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

// totalWrapped flattens cached display lines: entries + one blank separator.
func (m Model) totalWrapped(width int) []string {
	var lines []string
	for i := range m.transcript {
		lines = append(lines, m.transcript[i].displayLines(width)...)
		lines = append(lines, "")
	}
	return lines
}

// renderTranscript renders the transcript window. scroll<0 means stick to
// the bottom (auto-follow); scroll>=0 is a line offset from the top.
func (m Model) renderTranscript(width, height int) string {
	if height <= 0 {
		return ""
	}
	lines := m.totalWrapped(width)
	if len(lines) <= height {
		return strings.Join(lines, "\n")
	}
	if m.scroll < 0 {
		m.scroll = len(lines) - height
	}
	offset := m.scroll
	if offset > len(lines)-height {
		offset = len(lines) - height
	}
	if offset < 0 {
		offset = 0
	}
	return strings.Join(lines[offset:offset+height], "\n")
}

// scrolledUp reports whether the view is detached from the bottom.
func (m Model) scrolledUp(width, height int) bool {
	if m.scroll < 0 {
		return false
	}
	lines := m.totalWrapped(width)
	return m.scroll < len(lines)-height
}

// scrollBy moves the view offset, clamped; negative delta follows the tail.
func (m *Model) scrollBy(width, height, delta int) {
	lines := m.totalWrapped(width)
	max := len(lines) - height
	if max < 0 {
		max = 0
	}
	pos := m.scroll
	if pos < 0 {
		pos = max
	}
	pos += delta
	if pos > max {
		pos = max
	}
	if pos < 0 {
		pos = 0
	}
	if pos >= max {
		m.scroll = -1 // re-attach to the bottom
	} else {
		m.scroll = pos
	}
}
