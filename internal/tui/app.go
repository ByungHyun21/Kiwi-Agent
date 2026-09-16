// Package tui renders the kiwi agent terminal client surface.
// Current scope: screens only — server connection is not implemented yet.
package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

var (
	colorDeep  = lipgloss.Color("#3c5e20")
	colorSoft  = lipgloss.Color("#6b7062")
	colorLine  = lipgloss.Color("#c9c4b4")
	colorAmber = lipgloss.Color("#a86a1f")

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

	popupStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorDeep).
			PaddingLeft(1)

	popupSelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#ffffff")).
			Background(colorDeep)

	popupAliasStyle = lipgloss.NewStyle().Foreground(colorSoft)

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
	popupMaxRows    = 8
)

// command describes one slash command shown in the popup.
// Descriptions come from the active language table.
type command struct {
	name  string
	alias string // optional short form shown in the popup
}

var commands = []command{
	{"/project", ""},
	{"/new", ""},
	{"/resume", ""},
	{"/stop", "esc"},
	{"/server", ""},
	{"/exit", ""},
	{"/skill", ""},
	{"/model", ""},
	{"/btw", ""},
	{"/update", ""},
	{"/goal", ""},
	{"/queue", "/q"},
	{"/usage", ""},
	{"/git", ""},
	{"/mcp", ""},
	{"/compact", ""},
	{"/rename", ""},
	{"/init", ""},
	{"/language", ""},
}

var gitSubcommands = []string{"branch", "fork", "commit", "log", "status"}

// popupItem is one row of the command popup.
type popupItem struct {
	left  string // completion text
	name  string // display name column
	alias string // display shortcut column
	desc  string
}

// Model is the bubbletea model for the kiwi client surface.
type Model struct {
	msgIn     textinput.Model
	lang      Lang
	connected bool
	addr      string
	project   string
	sessions  []string
	messages  []string // sent messages, "." maps to "continue"
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

// candidates derives popup rows from the current input.
func (m Model) candidates() []popupItem {
	v := m.msgIn.Value()
	if !strings.HasPrefix(v, "/") {
		return nil
	}

	if arg, ok := strings.CutPrefix(v, "/language "); ok {
		if arg == "" {
			items := make([]popupItem, 0, len(langOrder))
			for _, l := range langOrder {
				items = append(items, popupItem{left: "/language " + string(l), name: string(l), desc: langNames[l]})
			}
			return items
		}
		if strings.Contains(arg, " ") {
			return nil
		}
		var items []popupItem
		for _, l := range langOrder {
			if strings.HasPrefix(string(l), arg) {
				items = append(items, popupItem{left: "/language " + string(l), name: string(l), desc: langNames[l]})
			}
		}
		return items
	}

	if arg, ok := strings.CutPrefix(v, "/git "); ok {
		if arg == "" {
			items := make([]popupItem, 0, len(gitSubcommands))
			for _, s := range gitSubcommands {
				items = append(items, popupItem{left: "/git " + s, name: s, desc: ""})
			}
			return items
		}
		if strings.Contains(arg, " ") {
			return nil
		}
		var items []popupItem
		for _, s := range gitSubcommands {
			if strings.HasPrefix(s, arg) {
				items = append(items, popupItem{left: "/git " + s, name: s, desc: ""})
			}
		}
		return items
	}

	if strings.Contains(v, " ") {
		return nil // command already complete, typing arguments
	}
	t := m.t()
	items := make([]popupItem, 0, len(commands))
	for _, c := range commands {
		if strings.HasPrefix(c.name, v) || (c.alias != "" && strings.HasPrefix(c.alias, v)) {
			items = append(items, popupItem{left: c.name, name: c.name, alias: c.alias, desc: t.CmdDescs[c.name]})
		}
	}
	return items
}

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

func (m Model) clampPopupSel(n int) int {
	if n <= 0 {
		return 0
	}
	if m.popupSel < 0 {
		return 0
	}
	if m.popupSel >= n {
		return n - 1
	}
	return m.popupSel
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

// conversation renders sent messages in the left area, bottom-aligned.
func (m Model) conversation(width, height int) string {
	if len(m.messages) == 0 || height <= 0 {
		return lipgloss.NewStyle().Width(width).Height(height).Render("")
	}
	visible := m.messages
	if len(visible) > height {
		visible = visible[len(visible)-height:]
	}
	lines := make([]string, 0, height)
	for range height - len(visible) {
		lines = append(lines, "")
	}
	for _, msg := range visible {
		lines = append(lines, truncate(msg, width))
	}
	return strings.Join(lines, "\n")
}

// View implements tea.Model.
func (m Model) View() string { return m.viewMain() }

func (m Model) statusBadge() string {
	if m.connected {
		return badgeOn.Render(m.t().Connected)
	}
	return badgeOff.Render(m.t().Disconnected)
}

func (m Model) rightPanel(height, width int) string {
	t := m.t()
	sections := []string{
		labelStyle.Render(t.ProjectLabel),
		m.projectLine(width - 4),
		"",
		labelStyle.Render(t.SessionLabel),
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
		return mutedStyle.Render(m.t().None)
	}
	return truncate(m.project, width)
}

func (m Model) sessionLines(width int) string {
	if len(m.sessions) == 0 {
		return mutedStyle.Render(m.t().NoSessions)
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

// popupView renders the full-width command popup shown below the input:
// name column and description column, both left-aligned, rows padded to
// the full width so the selection highlight spans the box.
func (m Model) popupView(width int) string {
	items := m.candidates()
	if len(items) == 0 || m.popupGone {
		return ""
	}

	// visible window around the selection
	sel := m.clampPopupSel(len(items))
	start := sel - popupMaxRows + 1
	if start < 0 {
		start = 0
	}
	if start+popupMaxRows > len(items) {
		start = len(items) - popupMaxRows
		if start < 0 {
			start = 0
		}
	}
	visible := items[start:min(start+popupMaxRows, len(items))]

	rowW := width - 4 // box border (2) + left padding
	if rowW < 20 {
		rowW = 20
	}

	// name column width from all candidates, not just the visible window
	nameW := 0
	for _, it := range items {
		nameW = max(nameW, lipgloss.Width(it.name)+4)
	}

	var rows []string
	for i, it := range visible {
		idx := start + i
		name := it.name
		if it.alias != "" {
			name += " " + popupAliasStyle.Render("("+it.alias+")")
		}
		row := padRight(name, nameW) + it.desc
		row = padRight(row, rowW)
		if idx == sel {
			row = popupSelStyle.Render(row)
		}
		rows = append(rows, row)
	}

	return popupStyle.
		Width(rowW).
		MaxHeight(popupMaxRows + 2).
		Render(strings.Join(rows, "\n"))
}

func padRight(s string, w int) string {
	gap := w - lipgloss.Width(s)
	if gap <= 0 {
		return s
	}
	return s + strings.Repeat(" ", gap)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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

	leftWidth := m.width - panelWidth(m.width) - 4 // panel border+padding
	if leftWidth < 4 {
		leftWidth = 4
	}
	popup := m.popupView(m.width)
	popupLines := lipgloss.Height(popup)

	// fixed bottom: blank + divider + input + popup + notice + help
	chrome := 7 + popupLines
	bodyHeight := m.height - chrome
	if bodyHeight < 4 {
		bodyHeight = 4
	}

	// conversation area: sent messages, bottom-aligned; blank until any exist
	left := m.conversation(leftWidth, bodyHeight)

	right := m.rightPanel(bodyHeight, panelWidth(m.width))
	body := lipgloss.JoinHorizontal(lipgloss.Top, left, right)

	divider := lipgloss.NewStyle().
		Foreground(colorLine).
		Render(strings.Repeat("─", max(10, m.width-2)))

	t := m.t()
	helpLeft := hintStyle.Render(t.HelpLeft)
	helpRight := hintStyle.Render(t.HelpRight)
	help := padRight(helpLeft, max(10, m.width-2)-lipgloss.Width(helpRight)) + helpRight

	cols := []string{
		header,
		"",
		body,
		"",
		divider,
		m.msgIn.View(),
	}
	if popupLines > 0 {
		cols = append(cols, popup)
	}
	cols = append(cols, m.notice, help)

	return lipgloss.JoinVertical(lipgloss.Left, cols...)
}
