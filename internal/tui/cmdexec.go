package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// cmdFunc executes one slash command; fields[0] is the command name.
type cmdFunc func(m Model, fields []string) (tea.Model, tea.Cmd)

// commandExecs dispatches slash commands. Unlisted commands (init, skill,
// mcp, git, update…) are consumed quietly.
var commandExecs = map[string]cmdFunc{
	"/exit":     cmdExit,
	"/server":   cmdServer,
	"/project":  cmdProject,
	"/model":    cmdModel,
	"/goal":     cmdGoal,
	"/new":      cmdNew,
	"/resume":   cmdResume,
	"/stop":     cmdStop,
	"/compact":  cmdCompact,
	"/btw":      cmdBtw,
	"/queue":    cmdQueue,
	"/rename":   cmdRename,
	"/usage":    cmdUsage,
	"/language": cmdLanguage,
}

// runCommand executes a slash command or sends a plain message.
func (m Model) runCommand(raw string) (tea.Model, tea.Cmd) {
	line := strings.TrimSpace(raw)
	if !strings.HasPrefix(line, "/") {
		return m.sendMessage(line)
	}
	fields := strings.Fields(line)
	m.msgIn.SetValue("")
	if fn, ok := commandExecs[fields[0]]; ok {
		return fn(m, fields)
	}
	m.notice = ""
	return m, nil
}

// sendMessage appends the user line and ships it, mapping "." to continue.
func (m Model) sendMessage(text string) (tea.Model, tea.Cmd) {
	if text == "" {
		return m, nil
	}
	if text == "." {
		text = "continue"
	}
	m.transcript = append(m.transcript, tline{kind: lineUser, text: text})
	m.notice = ""
	if m.client == nil {
		m.transcript = append(m.transcript, tline{kind: lineError, text: "서버에 연결되어 있지 않습니다. /server 로 연결하세요."})
		return m, nil
	}
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSend, Text: text})
}

// requireConn guards commands that need a live connection.
func (m *Model) requireConn() bool {
	if m.client != nil {
		return true
	}
	m.notice = "서버에 연결되어 있지 않습니다"
	return false
}

func arg(fields []string) string { return strings.Join(fields[1:], " ") }

func cmdExit(m Model, _ []string) (tea.Model, tea.Cmd) {
	return m, tea.Quit
}

func cmdServer(m Model, fields []string) (tea.Model, tea.Cmd) {
	if len(fields) >= 3 {
		return m.execAction(actConnectExec, "", strings.Join(fields[1:], " "))
	}
	if len(fields) == 2 { // /server token-only hint
		m.notice = m.t().ServerUsage
		return m, nil
	}
	m.menu = menuServer(m.connected, m.machines)
	if !m.hasServer() {
		return m, nil
	}
	return m, fetchMachines(m.addr, m.token)
}

func cmdProject(m Model, _ []string) (tea.Model, tea.Cmd) {
	if !m.hasServer() {
		m.notice = "먼저 /server 로 연결하세요"
		return m, nil
	}
	m.menu = menuProjects(m.projects, m.project)
	return m, fetchProjects(m.addr, m.token)
}

func cmdModel(m Model, _ []string) (tea.Model, tea.Cmd) {
	if !m.hasServer() {
		m.notice = "먼저 /server 로 연결하세요"
		return m, nil
	}
	m.menu = menuModels(nil, m.model)
	return m, fetchModels(m.addr, m.token)
}

func cmdGoal(m Model, fields []string) (tea.Model, tea.Cmd) {
	if len(fields) >= 2 {
		return m.execAction(actSetGoalExec, "", arg(fields))
	}
	m.menu = menuGoal(m.goal)
	return m, nil
}

func cmdNew(m Model, fields []string) (tea.Model, tea.Cmd) {
	if !m.requireConn() {
		return m, nil
	}
	// a fresh session starts on a blank screen
	m.transcript = nil
	m.streamKind = -1
	m.scroll = -1
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgNew, Text: arg(fields)})
}

func cmdResume(m Model, _ []string) (tea.Model, tea.Cmd) {
	if !m.requireConn() {
		return m, nil
	}
	m.menu = menuSessions(m.sessionIDs)
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSessions})
}

func cmdStop(m Model, _ []string) (tea.Model, tea.Cmd) {
	if m.client == nil {
		return m, nil
	}
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgStop})
}

func cmdCompact(m Model, _ []string) (tea.Model, tea.Cmd) {
	if !m.requireConn() {
		return m, nil
	}
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgCompact})
}

func cmdBtw(m Model, fields []string) (tea.Model, tea.Cmd) {
	if len(fields) < 2 {
		m.notice = "사용법: /btw <질문>"
		return m, nil
	}
	if !m.requireConn() {
		return m, nil
	}
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgBtw, Text: arg(fields)})
}

func cmdQueue(m Model, fields []string) (tea.Model, tea.Cmd) {
	if len(fields) < 2 {
		m.notice = "사용법: /queue <프롬프트>"
		return m, nil
	}
	if !m.requireConn() {
		return m, nil
	}
	// the server queues MsgSend while a turn is running
	return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSend, Text: arg(fields)})
}

func cmdRename(m Model, fields []string) (tea.Model, tea.Cmd) {
	if len(fields) < 2 || m.currentSession == "" {
		m.notice = "사용법: /rename <이름> (세션 열린 상태에서)"
		return m, nil
	}
	name := arg(fields)
	return m, func() tea.Msg {
		err := postJSON("PATCH", restURL(m.addr, "/api/sessions/"+m.currentSession), m.token,
			map[string]string{"name": name})
		return actionDoneMsg{err}
	}
}

func cmdUsage(m Model, _ []string) (tea.Model, tea.Cmd) {
	if m.currentSession == "" {
		m.notice = "열린 세션이 없습니다"
		return m, nil
	}
	return m, fetchUsage(m.addr, m.token, m.currentSession)
}

func cmdLanguage(m Model, fields []string) (tea.Model, tea.Cmd) {
	t := m.t()
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
}
