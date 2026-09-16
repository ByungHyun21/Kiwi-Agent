// Package tui renders the kiwi agent terminal client surface.
// Current scope: screens only — server connection is not implemented yet.
package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/lipgloss"
)

var (
	colorAccent = lipgloss.Color("#4f7a2c")
	colorDeep   = lipgloss.Color("#3c5e20")
	colorSoft   = lipgloss.Color("#6b7062")
	colorLine   = lipgloss.Color("#c9c4b4")
	colorAmber  = lipgloss.Color("#a86a1f")

	titleStyle = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#ffffff")).
		Background(colorDeep).
		Bold(true).
		Padding(0, 2)

	hintStyle  = lipgloss.NewStyle().Foreground(colorSoft)
	labelStyle = lipgloss.NewStyle().Foreground(colorSoft).Bold(true)
	mutedStyle = lipgloss.NewStyle().Foreground(colorSoft)

	panelStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorLine).
		Padding(0, 1)

	badgeOn = lipgloss.NewStyle().
		Foreground(lipgloss.Color("#8fce5a")).
		Bold(true)

	badgeOff = lipgloss.NewStyle().
		Foreground(colorAmber).
		Bold(true)
)

const (
	rightPanelWidth = 28
	maxSessions     = 3
)

// Model is the bubbletea model for the kiwi client surface.
type Model struct {
	msgIn     textinput.Model
	connected bool
	addr      string
	project   string
	sessions  []string
	notice    string
	width     int
	height    int
}

// New returns the initial model, starting directly at the main screen.
func New() Model {
	m := textinput.New()
	m.Placeholder = "메시지 입력 · /server /project /new /resume /stop"
	m.Prompt = "> "
	m.CharLimit = 4000
	m.Focus()
	return Model{msgIn: m}
}

// Init implements tea.Model.
func (m Model) Init() tea.Cmd { return textinput.Blink }

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.msgIn.Width = inputWidth(m.width)
		return m, nil

	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlC {
			return m, tea.Quit
		}
		if msg.Type == tea.KeyEnter {
			next, cmd, handled := m.runCommand(m.msgIn.Value())
			if handled {
				return next, cmd
			}
			m.msgIn.SetValue("")
			m.notice = ""
			return m, nil
		}
		var cmd tea.Cmd
		m.msgIn, cmd = m.msgIn.Update(msg)
		return m, cmd
	}
	return m, nil
}

// runCommand executes a slash command if the input starts with one.
// Returns handled=false for plain messages.
func (m Model) runCommand(raw string) (tea.Model, tea.Cmd, bool) {
	line := strings.TrimSpace(raw)
	if !strings.HasPrefix(line, "/") {
		return m, nil, false
	}
	fields := strings.Fields(line)
	switch fields[0] {
	case "/quit":
		return m, tea.Quit, true
	case "/server":
		m.msgIn.SetValue("")
		if len(fields) < 2 {
			m.notice = hintStyle.Render("사용법: /server <호스트:포트>")
		} else {
			m.addr = fields[1] // stored only; the address is never displayed
			m.notice = ""
		}
		return m, nil, true
	default:
		// other slash commands are surface-only for now: consume and stay quiet
		m.msgIn.SetValue("")
		m.notice = ""
		return m, nil, true
	}
}

// View implements tea.Model.
func (m Model) View() string {
	return m.viewMain()
}

func (m Model) statusBadge() string {
	if m.connected {
		return badgeOn.Render("서버 연결됨")
	}
	return badgeOff.Render("서버 연결 끊김")
}

func (m Model) rightPanel(height, width int) string {
	sections := []string{
		labelStyle.Render("프로젝트"),
		m.projectLine(width - 4),
		"",
		labelStyle.Render("세션"),
		m.sessionLines(width - 6),
	}
	content := lipgloss.JoinVertical(lipgloss.Left, sections...)
	inner := height - 2 // top/bottom border
	if inner > lipgloss.Height(content) {
		content += strings.Repeat("\n", inner-lipgloss.Height(content))
	}
	return panelStyle.
		Width(width).
		MaxHeight(height).
		Render(content)
}

func (m Model) projectLine(width int) string {
	if m.project == "" {
		return mutedStyle.Render("없음")
	}
	return truncate(m.project, width)
}

func (m Model) sessionLines(width int) string {
	if len(m.sessions) == 0 {
		return mutedStyle.Render("세션 없음")
	}
	var b strings.Builder
	for i, s := range m.sessions {
		if i >= maxSessions {
			break
		}
		b.WriteString("· " + truncate(s, width) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// panelWidth returns the right panel width for the current terminal width.
func panelWidth(w int) int {
	pw := rightPanelWidth
	if w < 100 {
		pw = w / 3
	}
	if pw > w-20 {
		pw = w - 20
	}
	if pw < 12 {
		pw = 12
	}
	return pw
}

// inputWidth returns the text input width for the current terminal width.
func inputWidth(w int) int {
	iw := w - panelWidth(w) - 4
	if iw < 10 {
		iw = 10
	}
	return iw
}

func truncate(s string, w int) string {
	if w < 1 {
		return ""
	}
	return ansi.Truncate(s, w, "…")
}

func (m Model) viewMain() string {
	if m.height <= 0 {
		m.height = 24
	}
	if m.width <= 0 {
		m.width = 80
	}

	header := lipgloss.JoinHorizontal(lipgloss.Left,
		titleStyle.Render("KIWI"),
		"  ",
		m.statusBadge(),
	)

	// fixed bottom: blank + notice + input + help below the body
	const chrome = 6
	bodyHeight := m.height - chrome
	if bodyHeight < 6 {
		bodyHeight = 6
	}
	pw := panelWidth(m.width)
	leftWidth := m.width - pw - 4 // panel border+padding
	if leftWidth < 4 {
		leftWidth = 4
	}

	// conversation area — intentionally blank until data exists
	left := lipgloss.NewStyle().Width(leftWidth).Height(bodyHeight).Render("")

	right := m.rightPanel(bodyHeight, pw)
	body := lipgloss.JoinHorizontal(lipgloss.Top, left, right)

	help := hintStyle.Render("/server · /project · /new · /resume /stop    /quit 종료")

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		body,
		"",
		m.msgIn.View(),
		m.notice,
		help,
	)
}
