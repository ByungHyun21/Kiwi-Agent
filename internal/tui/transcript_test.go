package tui

import (
	"strings"
	"testing"

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
