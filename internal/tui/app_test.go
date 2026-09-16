package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func sized(t *testing.T, w, h int) Model {
	t.Helper()
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	return mm.(Model)
}

func TestMainFrameFitsScreen(t *testing.T) {
	for _, sz := range [][2]int{{100, 30}, {80, 24}, {140, 50}, {60, 20}} {
		m := sized(t, sz[0], sz[1])
		lines := strings.Split(m.View(), "\n")
		if len(lines) != sz[1] {
			t.Fatalf("%dx%d: frame height = %d lines, want %d", sz[0], sz[1], len(lines), sz[1])
		}
	}
}

func TestServerCommandNoticePlacement(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/server")
	m2, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	view := m2.(Model).View()

	lines := strings.Split(view, "\n")
	noticeAt := -1
	for i, l := range lines {
		if strings.Contains(l, "사용법: /server") {
			noticeAt = i
			break
		}
	}
	if noticeAt < 0 {
		t.Fatal("usage notice missing for bare /server")
	}
	if noticeAt+1 >= len(lines) || !strings.Contains(lines[noticeAt+1], "/quit") {
		t.Fatalf("notice at line %d is not directly above help line", noticeAt)
	}
}

func TestAddressNeverDisplayed(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/server 192.168.125.129:5494")
	m2, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	view := m2.(Model).View()
	if strings.Contains(view, "192.168") {
		t.Fatal("server address leaked into view")
	}
	if m2.(Model).addr != "192.168.125.129:5494" {
		t.Fatalf("address not stored: %q", m2.(Model).addr)
	}
}

func TestPanelRendersAtNarrowWidth(t *testing.T) {
	m := sized(t, 60, 24)
	view := m.View()
	if !strings.Contains(view, "프로젝트") || !strings.Contains(view, "세션") {
		t.Fatal("right panel missing at width 60")
	}
	lines := strings.Split(view, "\n")
	if len(lines) != 24 {
		t.Fatalf("frame height = %d, want 24", len(lines))
	}
}
