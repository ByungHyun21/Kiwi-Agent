// Package tui renders the kiwi agent terminal client surface.
// Current scope: screens only — server connection is not implemented yet.
package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	colorAccent = lipgloss.Color("#4f7a2c")
	colorDeep   = lipgloss.Color("#3c5e20")
	colorInk    = lipgloss.Color("#23281f")
	colorSoft   = lipgloss.Color("#6b7062")
	colorPaper  = lipgloss.Color("#f5f3ec")
	colorLine   = lipgloss.Color("#c9c4b4")
	colorAmber  = lipgloss.Color("#a86a1f")

	titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#ffffff")).
			Background(colorDeep).
			Bold(true).
			Padding(0, 2)

	hintStyle  = lipgloss.NewStyle().Foreground(colorSoft)
	labelStyle = lipgloss.NewStyle().Foreground(colorSoft)
	mutedStyle = lipgloss.NewStyle().Foreground(colorSoft)

	cardStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorLine).
			Padding(2, 4)

	panelStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder(), false, false, false, true).
			BorderForeground(colorAccent).
			PaddingLeft(2)

	badgeOff = lipgloss.NewStyle().
			Foreground(colorAmber).
			Bold(true)
)

type screen int

const (
	screenAddr screen = iota
	screenMain
)

// Model is the bubbletea model for the kiwi client surface.
type Model struct {
	screen screen
	addrIn textinput.Model
	msgIn  textinput.Model
	addr   string
	width  int
	height int
}

// New returns the initial model, starting at the server-address screen.
func New() Model {
	a := textinput.New()
	a.Placeholder = "192.168.0.10:5494"
	a.Prompt = "서버 > "
	a.Focus()
	a.CharLimit = 120

	m := textinput.New()
	m.Placeholder = "메시지 입력 · /project /new /resume /stop"
	m.Prompt = "> "
	m.CharLimit = 4000

	return Model{screen: screenAddr, addrIn: a, msgIn: m}
}

// Init implements tea.Model.
func (m Model) Init() tea.Cmd { return textinput.Blink }

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tea.KeyMsg:
		if m.screen == screenAddr {
			switch msg.Type {
			case tea.KeyEnter:
				addr := strings.TrimSpace(m.addrIn.Value())
				if addr == "" {
					return m, nil
				}
				m.addr = addr
				m.screen = screenMain
				m.addrIn.Blur()
				m.msgIn.Focus()
				return m, textinput.Blink
			case tea.KeyCtrlC, tea.KeyEsc:
				return m, tea.Quit
			}
			var cmd tea.Cmd
			m.addrIn, cmd = m.addrIn.Update(msg)
			return m, cmd
		}

		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "enter":
			if strings.HasPrefix(strings.TrimSpace(m.msgIn.Value()), "/quit") {
				return m, tea.Quit
			}
			m.msgIn.SetValue("")
			return m, nil
		}
		var cmd tea.Cmd
		m.msgIn, cmd = m.msgIn.Update(msg)
		return m, cmd
	}
	return m, nil
}

// View implements tea.Model.
func (m Model) View() string {
	if m.screen == screenAddr {
		return m.viewAddr()
	}
	return m.viewMain()
}

func (m Model) viewAddr() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render("KIWI AGENT"),
		"",
		"서버 주소를 입력해 연결하세요.",
		mutedStyle.Render("로컬망의 kiwi-server 주소 (예: 192.168.0.10:5494)"),
		"",
		m.addrIn.View(),
		"",
		hintStyle.Render("Enter 연결 · Ctrl+C 종료"),
	)
	card := cardStyle.Render(body)
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, card)
}

func (m Model) viewMain() string {
	header := lipgloss.JoinHorizontal(lipgloss.Left,
		titleStyle.Render("KIWI"),
		labelStyle.Render("  서버 "),
		lipgloss.NewStyle().Foreground(colorAccent).Render(m.addr),
		labelStyle.Render("  상태 "),
		badgeOff.Render("미연결"),
	)

	project := panelStyle.Render(lipgloss.JoinVertical(lipgloss.Left,
		"선택된 프로젝트 없음",
		mutedStyle.Render("/project 로 프로젝트를 선택하세요"),
	))

	session := panelStyle.Render(lipgloss.JoinVertical(lipgloss.Left,
		"세션 없음",
		mutedStyle.Render("/new 로 새 세션을 시작하거나 /resume 으로 이어하세요"),
	))

	footer := hintStyle.Render("/project · /new · /resume · /stop    /quit 종료")

	body := lipgloss.JoinVertical(lipgloss.Left,
		header,
		"",
		strings.Repeat("─", max(40, min(m.width-2, 100))),
		"",
		"프로젝트",
		project,
		"",
		"세션",
		session,
		"",
		m.msgIn.View(),
		"",
		footer,
	)

	return lipgloss.NewStyle().Padding(1, 2).Render(body)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
