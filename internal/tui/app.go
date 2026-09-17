// Package tui renders the kiwi agent terminal client: server connection,
// raw streaming transcript, command popup, fullscreen menus and sidebar.
package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// Model is the bubbletea model for the kiwi client.
type Model struct {
	msgIn     textinput.Model
	lang      Lang
	connected bool
	addr      string
	token     string
	client    *wsClient

	project  string
	projID   string
	machine  string
	model    string
	provider string
	goal     string
	todos    []string
	ctxUsed  int
	ctxMax   int
	tokens   int

	sessions       []string
	sessionIDs     []protocol.SessionInfo
	currentSession string
	projects       []protocol.Project
	machines       []protocol.Machine
	wantProject    string

	transcript []tline
	streamKind int
	busy       bool
	spinner    int

	notice    string
	popupSel  int
	popupGone bool
	menu      *menu
	width     int
	height    int
}

func (m Model) hasServer() bool { return m.addr != "" }

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

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

// Run starts the kiwi terminal client.
func Run() error {
	_, err := tea.NewProgram(New(), tea.WithAltScreen()).Run()
	return err
}

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.msgIn.Width = inputWidth(m.width)
		return m, nil

	case tickMsg:
		if !m.busy {
			return m, nil
		}
		m.spinner = (m.spinner + 1) % len(spinnerFrames)
		return m, tick()

	case wsEventMsg:
		wasBusy := m.busy
		m.applyEvent(msg.ev)
		var cmds []tea.Cmd
		if m.client != nil {
			cmds = append(cmds, m.client.readOne())
		}
		if m.busy && !wasBusy {
			cmds = append(cmds, tick())
		}
		return m, tea.Batch(cmds...)

	case wsClosedMsg:
		m.client = nil
		m.connected = false
		m.busy = false
		m.transcript = append(m.transcript, tline{lineError, "서버 연결이 끊겼습니다"})
		return m, nil

	case projectsMsg:
		if msg.err != nil {
			m.notice = "프로젝트 조회 실패: " + msg.err.Error()
			return m, nil
		}
		if m.menu != nil && m.menu.title == "프로젝트" {
			m.menu = menuProjects(msg.list, m.project)
		}
		m.projects = msg.list
		return m, nil

	case modelsMsg:
		if msg.err != nil {
			m.notice = "모델 조회 실패: " + msg.err.Error()
			return m, nil
		}
		if m.menu != nil && m.menu.title == "모델" {
			m.menu = menuModels(msg.list, m.model)
		}
		return m, nil

	case machinesMsg:
		if msg.err != nil {
			m.notice = "기기 조회 실패: " + msg.err.Error()
			return m, nil
		}
		if m.menu != nil && m.menu.title == "서버" {
			m.menu = menuServer(m.connected, msg.list)
		}
		return m, nil

	case roleMsg:
		if msg.err == nil {
			m.provider, m.model = msg.provider, msg.model
		}
		return m, nil

	case sessionsForProjectMsg:
		if msg.err != nil {
			m.notice = msg.err.Error()
			return m, nil
		}
		m.sessionIDs = msg.sessions
		m.sessions = nil
		for _, s := range msg.sessions {
			m.sessions = append(m.sessions, s.Name)
		}
		if len(msg.sessions) > 0 {
			newest := msg.sessions[0]
			m.currentSession = newest.ID
			return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgResume, SessionID: newest.ID})
		}
		m.transcript = append(m.transcript, tline{lineNotice, "이 프로젝트의 세션이 없습니다. /new 로 시작하세요"})
		return m, nil

	case usageMsg:
		if msg.err != nil {
			m.notice = "사용량 조회 실패: " + msg.err.Error()
			return m, nil
		}
		m.tokens = int(msg.prompt + msg.completion)
		m.transcript = append(m.transcript, tline{lineNotice,
			fmt.Sprintf("세션 토큰 사용량 — 프롬프트 %d + 완성 %d = %d", msg.prompt, msg.completion, msg.prompt+msg.completion)})
		return m, nil

	case actionDoneMsg:
		if msg.err != nil {
			m.notice = msg.err.Error()
		}
		return m, nil

	case connectResultMsg:
		if msg.err != nil {
			m.connected = false
			m.transcript = append(m.transcript, tline{lineError, "연결 실패: " + msg.err.Error()})
			return m, nil
		}
		m.client = msg.client
		m.connected = true
		m.transcript = append(m.transcript, tline{lineNotice, "서버에 연결되었습니다"})
		return m, tea.Batch(m.client.readOne(), m.afterConnect())

	case tea.KeyMsg:
		if m.menu != nil {
			next, cmd := m.updateMenu(msg)
			return next, cmd
		}
		return m.updateKeys(msg)
	}
	return m, nil
}

// afterConnect pulls role, machines and sessions after a fresh connection.
func (m Model) afterConnect() tea.Cmd {
	return tea.Batch(fetchRole(m.addr, m.token), fetchMachines(m.addr, m.token))
}

// updateKeys handles keys on the main screen.
func (m Model) updateKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
		return m.runCommand(m.msgIn.Value())
	}
	var cmd tea.Cmd
	m.msgIn, cmd = m.msgIn.Update(msg)
	m.popupGone = false
	m.popupSel = m.clampPopupSel(len(m.candidates()))
	return m, cmd
}

// runCommand executes a slash command or sends a plain message.
func (m Model) runCommand(raw string) (tea.Model, tea.Cmd) {
	line := strings.TrimSpace(raw)
	if !strings.HasPrefix(line, "/") {
		if line == "" {
			return m, nil
		}
		if line == "." {
			line = "continue"
		}
		m.transcript = append(m.transcript, tline{lineUser, line})
		m.msgIn.SetValue("")
		m.notice = ""
		if m.client == nil {
			m.transcript = append(m.transcript, tline{lineError, "서버에 연결되어 있지 않습니다. /server 로 연결하세요."})
			return m, nil
		}
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSend, Text: line})
	}

	fields := strings.Fields(line)
	t := m.t()
	switch fields[0] {
	case "/exit":
		return m, tea.Quit
	case "/server":
		m.msgIn.SetValue("")
		if len(fields) >= 3 {
			return m.execAction(actConnectExec, "", strings.Join(fields[1:], " "))
		}
		if len(fields) == 2 { // /server token-only hint
			m.notice = t.ServerUsage
			return m, nil
		}
		m.menu = menuServer(m.connected, m.machines)
		if !m.hasServer() {
			return m, nil
		}
		return m, fetchMachines(m.addr, m.token)
	case "/project":
		m.msgIn.SetValue("")
		if !m.hasServer() {
			m.notice = "먼저 /server 로 연결하세요"
			return m, nil
		}
		m.menu = menuProjects(m.projects, m.project)
		return m, fetchProjects(m.addr, m.token)
	case "/model":
		m.msgIn.SetValue("")
		if !m.hasServer() {
			m.notice = "먼저 /server 로 연결하세요"
			return m, nil
		}
		m.menu = menuModels(nil, m.model)
		return m, fetchModels(m.addr, m.token)
	case "/goal":
		m.msgIn.SetValue("")
		if len(fields) >= 2 {
			return m.execAction(actSetGoalExec, "", strings.Join(fields[1:], " "))
		}
		m.menu = menuGoal(m.goal)
		return m, nil
	case "/new":
		m.msgIn.SetValue("")
		if m.client == nil {
			m.notice = "서버에 연결되어 있지 않습니다"
			return m, nil
		}
		name := strings.Join(fields[1:], " ")
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgNew, Text: name})
	case "/resume":
		m.msgIn.SetValue("")
		if m.client == nil {
			m.notice = "서버에 연결되어 있지 않습니다"
			return m, nil
		}
		m.menu = menuSessions(m.sessionIDs)
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSessions})
	case "/stop":
		m.msgIn.SetValue("")
		if m.client == nil {
			return m, nil
		}
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgStop})
	case "/compact":
		m.msgIn.SetValue("")
		if m.client == nil {
			m.notice = "서버에 연결되어 있지 않습니다"
			return m, nil
		}
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgCompact})
	case "/btw":
		m.msgIn.SetValue("")
		if len(fields) < 2 {
			m.notice = "사용법: /btw <질문>"
			return m, nil
		}
		if m.client == nil {
			m.notice = "서버에 연결되어 있지 않습니다"
			return m, nil
		}
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgBtw, Text: strings.Join(fields[1:], " ")})
	case "/queue":
		m.msgIn.SetValue("")
		if len(fields) < 2 {
			m.notice = "사용법: /queue <프롬프트>"
			return m, nil
		}
		if m.client == nil {
			m.notice = "서버에 연결되어 있지 않습니다"
			return m, nil
		}
		return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSend, Text: strings.Join(fields[1:], " ")})
	case "/rename":
		m.msgIn.SetValue("")
		if len(fields) < 2 || m.currentSession == "" {
			m.notice = "사용법: /rename <이름> (세션 열린 상태에서)"
			return m, nil
		}
		name := strings.Join(fields[1:], " ")
		return m, func() tea.Msg {
			err := postJSON("PATCH", restURL(m.addr, "/api/sessions/"+m.currentSession), m.token,
				map[string]string{"name": name})
			return actionDoneMsg{err}
		}
	case "/usage":
		m.msgIn.SetValue("")
		if m.currentSession == "" {
			m.notice = "열린 세션이 없습니다"
			return m, nil
		}
		return m, fetchUsage(m.addr, m.token, m.currentSession)
	case "/language":
		m.msgIn.SetValue("")
		if len(fields) < 2 || !validLang(Lang(fields[1])) {
			m.notice = hintStyle.Render(t.LanguageUsage)
			return m, nil
		}
		m.lang = Lang(fields[1])
		m.msgIn.Placeholder = m.t().Placeholder
		m.notice = fmt.Sprintf(m.t().LanguageChanged, langNames[m.lang])
		if err := saveLang(m.lang); err != nil {
			m.notice = m.t().SaveFailed + ": " + err.Error()
		}
		return m, nil
	default:
		// unimplemented commands (init, skill, mcp, git, update…): consume quietly
		m.msgIn.SetValue("")
		m.notice = ""
		return m, nil
	}
}

// tick drives the spinner animation while busy.
func tick() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg { return tickMsg{} })
}

// View implements tea.Model.
func (m Model) View() string { return m.viewMain() }

func (m Model) statusBadge() string {
	if m.connected {
		return badgeOn.Render(m.t().Connected)
	}
	return badgeOff.Render(m.t().Disconnected)
}

func (m Model) spinnerLine() string {
	if !m.busy {
		return ""
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color("#a8c17a")).Bold(true).
		Render(spinnerFrames[m.spinner] + " 진행 중…")
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

	chrome := 6 + popupLines
	bodyHeight := m.height - chrome
	if bodyHeight < 4 {
		bodyHeight = 4
	}

	// conversation or fullscreen menu, right of the vertical rule;
	// force the full column width even when the transcript is empty
	var left string
	if m.menu != nil {
		left = m.menu.render(leftWidth, bodyHeight)
	} else {
		left = m.renderTranscript(leftWidth, bodyHeight)
	}
	left = lipgloss.NewStyle().Width(leftWidth).MaxHeight(bodyHeight).Render(left)

	leftCol := lipgloss.JoinVertical(lipgloss.Left, header, "", left)
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
	if sp := m.spinnerLine(); sp != "" {
		cols = append(cols, sp)
	}
	if popupLines > 0 {
		cols = append(cols, popup)
	}
	cols = append(cols, m.notice, help)

	return lipgloss.JoinVertical(lipgloss.Left, cols...)
}

// machineDefault / workdirDefault fill project creation defaults.
func (m Model) machineDefault() string { return "local" }

func (m Model) workdirDefault() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Desktop", "workspace", m.wantProject)
}
