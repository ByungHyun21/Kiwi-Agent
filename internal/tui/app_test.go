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

func submit(m Model, text string) Model {
	m.msgIn.SetValue(text)
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
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

func TestFrameFitsWithPopupOpen(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/")
	view := m.View()
	lines := strings.Split(view, "\n")
	if len(lines) != 30 {
		t.Fatalf("frame height with popup = %d lines, want 30", len(lines))
	}
	for _, want := range []string{"/project", "/resume"} {
		if !strings.Contains(view, want) {
			t.Fatalf("popup missing %s", want)
		}
	}
	if strings.Contains(view, "/rename") {
		t.Fatal("popup shows beyond the 8-row window before scrolling")
	}
}

func TestPopupScrollsToLaterCommands(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/")
	mm := m
	for range 14 { // /rename is item index 14 of 16; step the selection there
		next, _ := mm.Update(tea.KeyMsg{Type: tea.KeyDown})
		mm = next.(Model)
	}
	if !strings.Contains(mm.View(), "/rename") {
		t.Fatal("scrolling did not bring /rename into view")
	}
}

func TestCommandPopupFilters(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/re")
	view := m.View()
	if !strings.Contains(view, "/resume") || !strings.Contains(view, "/rename") {
		t.Fatal("filter broken for /re")
	}
	if strings.Contains(view, "/project") {
		t.Fatal("unrelated command /project shown for /re")
	}
	if strings.Contains(view, "(.)") {
		t.Fatal("/resume must not show a shortcut")
	}
}

func TestPopupSelectionCompletes(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/re") // items: /resume, /rename
	m1, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m2, _ := m1.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m2.(Model).msgIn.Value(); got != "/rename " {
		t.Fatalf("completed to %q, want %q", got, "/rename ")
	}
}

func TestPopupExactMatchExecutes(t *testing.T) {
	m := sized(t, 100, 30)
	m2 := submit(m, "/model") // single exact match → runs (quiet consume)
	if got := m2.msgIn.Value(); got != "" {
		t.Fatalf("input after exact-match run = %q, want empty", got)
	}
}

func TestGitSubcommandPopup(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/git ")
	view := m.View()
	for _, s := range []string{"branch", "fork", "commit", "log", "status"} {
		if !strings.Contains(view, s) {
			t.Fatalf("subcommand %s missing", s)
		}
	}
}

func TestQueueAliasSurfacesCommand(t *testing.T) {
	m := sized(t, 100, 30)
	m.msgIn.SetValue("/q")
	if !strings.Contains(m.View(), "/queue") {
		t.Fatal("/q should surface /queue")
	}
}

func TestDotSendsContinue(t *testing.T) {
	m := sized(t, 100, 30)
	m2 := submit(m, ".")
	if len(m2.messages) != 1 || m2.messages[0] != "continue" {
		t.Fatalf("messages = %v, want [continue]", m2.messages)
	}
	if !strings.Contains(m2.View(), "continue") {
		t.Fatal("sent message not rendered in conversation area")
	}
}

func TestPlainMessageRendered(t *testing.T) {
	m := sized(t, 100, 30)
	m2 := submit(m, "회로도 검토해줘")
	if len(m2.messages) != 1 || m2.messages[0] != "회로도 검토해줘" {
		t.Fatalf("messages = %v", m2.messages)
	}
}

func TestServerCommandNoticePlacement(t *testing.T) {
	m := sized(t, 100, 30)
	m2 := submit(m, "/server")
	view := m2.View()

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
	if noticeAt+1 >= len(lines) || !strings.Contains(lines[noticeAt+1], "/exit") {
		t.Fatalf("notice at line %d is not directly above help line", noticeAt)
	}
}

func TestAddressNeverDisplayed(t *testing.T) {
	m := sized(t, 100, 30)
	m2 := submit(m, "/server 192.168.125.129:5494")
	view := m2.View()
	if strings.Contains(view, "192.168") {
		t.Fatal("server address leaked into view")
	}
	if m2.addr != "192.168.125.129:5494" {
		t.Fatalf("address not stored: %q", m2.addr)
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
