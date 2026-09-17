package tui

import (
	"strings"
	"testing"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"

	tea "github.com/charmbracelet/bubbletea"
)

func scrolled(t *testing.T, entries ...tline) Model {
	t.Helper()
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 20})
	m2 := mm.(Model)
	for _, e := range entries {
		m2.transcript = append(m2.transcript, e)
	}
	return m2
}

func TestScrollShowsOlderContent(t *testing.T) {
	entries := []tline{{kind: lineUser, text: "첫 줄 — 위로 스크롤하면 보여야 함"}}
	for i := range 40 {
		entries = append(entries, tline{kind: lineAssistant, text: strings.Repeat("내용", 3)})
		_ = i
	}
	m := scrolled(t, entries...)
	w, h := m.widthToBody(), m.heightToBody()

	bottom := m.renderTranscript(w, h)
	if strings.Contains(bottom, "첫 줄") {
		t.Fatal("first line should be scrolled out at bottom view")
	}

	m.scrollBy(w, h, -100000) // wheel up to top
	top := m.renderTranscript(w, h)
	if !strings.Contains(top, "첫 줄") {
		t.Fatal("scrolled-up view must show the first line")
	}

	// wheel down past the end re-attaches to the bottom
	m.scrollBy(w, h, 100000)
	bottom2 := m.renderTranscript(w, h)
	if strings.Contains(bottom2, "첫 줄") || m.scroll != -1 {
		t.Fatalf("should re-attach to bottom: scroll=%d", m.scroll)
	}
}

func TestStreamAppendOnlyRewrapsLastLine(t *testing.T) {
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m2 := mm.(Model)
	m2.appendStream(lineUser, "이전 사용자 메시지")
	m2.appendStream(lineReasoning, "초기 사고 내용")
	m2.renderTranscript(m2.widthToBody(), m2.heightToBody())
	cached := m2.transcript[0].wrapped
	if len(cached) == 0 {
		t.Fatal("expected wrap cache")
	}

	m2.appendStream(lineReasoning, " 이어지는 델타")
	if m2.transcript[0].wrapped == nil || m2.transcript[0].wrapped[0] != cached[0] {
		t.Fatal("earlier line cache was invalidated by a delta append")
	}
	view := m2.View()
	if !strings.Contains(view, "이어지는 델타") {
		t.Fatal("appended delta not rendered")
	}
}

func TestAssistantMarkdownRenders(t *testing.T) {
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m2 := mm.(Model)
	m2.busy = false
	m2.transcript = append(m2.transcript, tline{kind: lineAssistant, text: "| 파일 | 크기 |\n|---|---|\n| index.html | 2KB |\n\n```html\n<h1>Hi</h1>\n```\n\n- 첫 번째 항목\n- 두 번째 항목\n"})
	view := m2.View()
	// glamour renders GFM tables with padding pipes and code blocks with a bordered/indented block
	if !strings.Contains(view, "|") {
		t.Fatal("table not rendered")
	}
	if !strings.Contains(view, "Hi") {
		t.Fatal("code block content missing")
	}
	if !strings.Contains(view, "•") {
		t.Fatal("bullet not rendered")
	}
	if !strings.Contains(view, "첫 번째 항목") {
		t.Fatal("bullet text missing")
	}
}

func TestSpinnerVisibleWhileBusy(t *testing.T) {
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m2 := mm.(Model)
	m2.applyEvent(protocol.Event{Type: protocol.EvStatus, Name: "working"})
	m2.applyEvent(protocol.Event{Type: protocol.EvToolCall, Name: "write_file", Args: "{}"})
	view := m2.View()
	if !strings.Contains(view, "진행 중") || !strings.Contains(view, "write_file") {
		t.Fatal("spinner with tool hint missing while busy")
	}
	if len(strings.Split(view, "\n")) != 24 {
		t.Fatalf("busy frame height = %d, want 24", len(strings.Split(view, "\n")))
	}

	m2.applyEvent(protocol.Event{Type: protocol.EvToolResult, Result: "done"})
	m2.applyEvent(protocol.Event{Type: protocol.EvStatus, Name: "idle"})
	if strings.Contains(m2.View(), "진행 중") {
		t.Fatal("spinner persisted after idle")
	}
}

func TestMouseSequenceSanitized(t *testing.T) {
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m2 := mm.(Model)
	m2.msgIn.SetValue("hello\x1b[<65;56;30Mworld")
	m2.sanitizeInput()
	if got := m2.msgIn.Value(); got != "helloworld" {
		t.Fatalf("input = %q, want helloworld", got)
	}
}
