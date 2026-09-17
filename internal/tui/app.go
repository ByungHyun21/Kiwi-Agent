// Package tui renders the kiwi agent terminal client surface.
// Current scope: screens only — server connection is not implemented yet.
package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Model is the bubbletea model for the kiwi client surface.
type Model struct {
	msgIn     textinput.Model
	lang      Lang
	connected bool
	addr      string
	project   string
	sessions  []string
	messages  []string // sent messages, "." maps to "continue"
	model     string   // active chat model
	machine   string   // work machine of the current project
	goal      string
	todos     []string
	ctxUsed   int // context window usage
	ctxMax    int
	notice    string
	popupSel  int
	popupGone bool // popup dismissed with Esc until input changes
	width     int
	height    int
}

// New returns the initial model, starting directly at the main screen.
// The language preference is loaded from disk.
func New() Model {
	lang := loadLang()
	m := textinput.New()
	m.Placeholder = translations[lang].Placeholder
	m.Prompt = "> "
	m.CharLimit = 4000
	m.Focus()
	return Model{msgIn: m, lang: lang}
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
		items := m.candidates()
		popupOpen := len(items) > 0 && !m.popupGone

		if popupOpen {
			switch msg.Type {
			case tea.KeyTab:
				// replace the input with the selected command
				m.msgIn.SetValue(items[m.clampPopupSel(len(items))].left)
				return m, nil
			case tea.KeyUp, tea.KeyDown:
				if msg.Type == tea.KeyUp {
					m.popupSel--
				} else {
					m.popupSel++
				}
				n := len(items)
				m.popupSel = ((m.popupSel % n) + n) % n
				return m, nil
			case tea.KeyEsc:
				m.popupGone = true
				return m, nil
			case tea.KeyEnter:
				v := strings.TrimRight(m.msgIn.Value(), " ")
				if len(items) == 1 && items[0].left == v {
					// exact match: fall through and execute below
					break
				}
				item := items[m.clampPopupSel(len(items))]
				m.msgIn.SetValue(item.left + " ")
				m.popupSel = 0
				m.popupGone = false
				return m, nil
			}
		}

		if msg.Type == tea.KeyCtrlC {
			// clear the input line; quitting is /exit
			m.msgIn.SetValue("")
			m.notice = ""
			return m, nil
		}
		if msg.Type == tea.KeyEsc {
			// /stop surface behavior: consume quietly
			m.msgIn.SetValue("")
			m.notice = ""
			return m, nil
		}
		if msg.Type == tea.KeyEnter {
			next, cmd, handled := m.runCommand(m.msgIn.Value())
			if handled {
				return next, cmd
			}
			if text := strings.TrimSpace(m.msgIn.Value()); text != "" {
				if text == "." {
					text = "continue" // shorthand for resuming interrupted work
				}
				m.messages = append(m.messages, text)
			}
			m.msgIn.SetValue("")
			m.notice = ""
			return m, nil
		}
		var cmd tea.Cmd
		m.msgIn, cmd = m.msgIn.Update(msg)
		m.popupGone = false
		m.popupSel = m.clampPopupSel(len(m.candidates()))
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
	t := m.t()
	switch fields[0] {
	case "/exit":
		return m, tea.Quit, true
	case "/server":
		m.msgIn.SetValue("")
		if len(fields) < 2 {
			m.notice = hintStyle.Render(t.ServerUsage)
		} else {
			m.addr = fields[1] // stored only; the address is never displayed
			m.notice = ""
		}
		return m, nil, true
	case "/language":
		m.msgIn.SetValue("")
		if len(fields) < 2 || !validLang(Lang(fields[1])) {
			m.notice = hintStyle.Render(t.LanguageUsage)
			return m, nil, true
		}
		m.lang = Lang(fields[1])
		m.msgIn.Placeholder = m.t().Placeholder
		m.notice = fmt.Sprintf(m.t().LanguageChanged, langNames[m.lang])
		if err := saveLang(m.lang); err != nil {
			m.notice = m.t().SaveFailed + ": " + err.Error()
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
func (m Model) View() string { return m.viewMain() }

func (m Model) statusBadge() string {
	if m.connected {
		return badgeOn.Render(m.t().Connected)
	}
	return badgeOff.Render(m.t().Disconnected)
}

// Run starts the kiwi terminal client.
func Run() error {
	_, err := tea.NewProgram(New(), tea.WithAltScreen()).Run()
	return err
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

	pw := panelWidth(m.width)
	leftWidth := m.width - pw - 3 // vertical rule + panel padding
	if leftWidth < 4 {
		leftWidth = 4
	}
	popup := m.popupView(m.width)
	popupLines := lipgloss.Height(popup)

	// body = header + blank + conversation; the vertical rule runs along its
	// right edge from the top of the window down to the input divider
	chrome := 6 + popupLines // 2 header lines + divider + input + notice + help
	bodyHeight := m.height - chrome
	if bodyHeight < 4 {
		bodyHeight = 4
	}

	// conversation area: sent messages, bottom-aligned; blank until any exist
	conversation := m.conversation(leftWidth, bodyHeight)

	leftCol := lipgloss.JoinVertical(lipgloss.Left, header, "", conversation)
	leftCol = lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, true, false, false).
		BorderForeground(colorLine).
		Render(leftCol)

	right := m.rightPanel(bodyHeight+2, pw)
	body := lipgloss.JoinHorizontal(lipgloss.Top, leftCol, right)

	divider := lipgloss.NewStyle().
		Foreground(colorLine).
		Render(strings.Repeat("─", max(10, m.width-2)))

	t := m.t()
	helpLeft := hintStyle.Render(t.HelpLeft)
	helpRight := hintStyle.Render(t.HelpRight)
	help := padRight(helpLeft, max(10, m.width-2)-lipgloss.Width(helpRight)) + helpRight

	cols := []string{
		body,
		divider,
		m.msgIn.View(),
	}
	if popupLines > 0 {
		cols = append(cols, popup)
	}
	cols = append(cols, m.notice, help)

	return lipgloss.JoinVertical(lipgloss.Left, cols...)
}
