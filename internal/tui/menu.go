package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// menuAction identifies what Enter triggers on a menu item.
type menuAction int

const (
	actClose menuAction = iota
	actOpenProject
	actNewProjectInput
	actDeleteProjectConfirm
	actConnectInput
	actDisconnect
	actRegisterMachineInput
	actSetModel
	actRefreshModels
	actSetGoalInput
	actClearGoal
	actResumeSession
)

type menuItem struct {
	label   string
	desc    string
	action  menuAction
	payload string
}

type menuMode int

const (
	menuList menuMode = iota
	menuInput
	menuConfirm
)

// menu is the fullscreen submenu state (covers the conversation area).
type menu struct {
	title  string
	items  []menuItem
	sel    int
	mode   menuMode
	input  textinput.Model
	prompt string     // input label or confirm question
	act    menuAction // action pending input/confirm
	arg    string     // payload captured when the action started
}

func newMenu(title string, items []menuItem) *menu {
	in := textinput.New()
	in.Prompt = "> "
	in.CharLimit = 400
	in.Focus()
	return &menu{title: title, items: items, input: in}
}

func (mu *menu) clampSel() {
	if mu.sel < 0 {
		mu.sel = 0
	}
	if mu.sel >= len(mu.items) {
		mu.sel = len(mu.items) - 1
	}
}

// update handles keys while the menu is open.
func (m Model) updateMenu(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	mu := m.menu
	switch mu.mode {
	case menuList:
		switch msg.Type {
		case tea.KeyEsc:
			m.menu = nil
			return m, nil
		case tea.KeyUp:
			mu.sel--
		case tea.KeyDown, tea.KeyTab:
			mu.sel++
		case tea.KeyEnter:
			mu.clampSel()
			item := mu.items[mu.sel]
			return m.startAction(item.action, item.payload)
		default:
			return m, nil
		}
		mu.clampSel()
		return m, nil
	case menuInput:
		switch msg.Type {
		case tea.KeyEsc:
			mu.mode = menuList
			mu.input.SetValue("")
			return m, nil
		case tea.KeyEnter:
			val := strings.TrimSpace(mu.input.Value())
			if val == "" {
				return m, nil
			}
			act, arg := mu.act, mu.arg
			m.menu = nil
			return m.execAction(act, arg, val)
		}
		var cmd tea.Cmd
		mu.input, cmd = mu.input.Update(msg)
		return m, cmd
	case menuConfirm:
		switch msg.String() {
		case "enter", "y", "Y":
			act, arg := mu.act, mu.arg
			m.menu = nil
			return m.execAction(act, arg, "")
		case "esc", "n", "N":
			mu.mode = menuList
			return m, nil
		}
		return m, nil
	}
	return m, nil
}

// startAction switches to input/confirm modes or executes immediately.
func (m Model) startAction(act menuAction, payload string) (tea.Model, tea.Cmd) {
	mu := m.menu
	switch act {
	case actNewProjectInput:
		mu.mode = menuInput
		mu.prompt = "새 프로젝트 이름 (Esc 취소)"
		mu.act, mu.arg = actOpenProjectCreate, payload
		mu.input.SetValue("")
		return m, textinput.Blink
	case actConnectInput:
		mu.mode = menuInput
		mu.prompt = "서버 주소:포트 토큰 (Esc 취소)"
		mu.act, mu.arg = actConnectExec, payload
		mu.input.SetValue("")
		return m, textinput.Blink
	case actRegisterMachineInput:
		mu.mode = menuInput
		mu.prompt = "기기: 이름 호스트 포트 사용자 (Esc 취소)"
		mu.act, mu.arg = actRegisterMachineExec, payload
		mu.input.SetValue("")
		return m, textinput.Blink
	case actSetGoalInput:
		mu.mode = menuInput
		mu.prompt = "목표 한 줄 (Esc 취소)"
		mu.act, mu.arg = actSetGoalExec, payload
		mu.input.SetValue("")
		return m, textinput.Blink
	case actDeleteProjectConfirm:
		mu.mode = menuConfirm
		mu.prompt = "프로젝트 '" + payload + "' 등록을 삭제할까요? (Enter 삭제 · Esc 취소) — 실제 폴더는 유지됩니다"
		mu.act, mu.arg = actDeleteProjectExec, payload
		return m, nil
	}
	m.menu = nil
	return m.execAction(act, payload, "")
}

// extra actions that only exist after input/confirm
const (
	actOpenProjectCreate menuAction = 100 + iota
	actConnectExec
	actRegisterMachineExec
	actSetGoalExec
	actDeleteProjectExec
)

func (m Model) execAction(act menuAction, payload, input string) (tea.Model, tea.Cmd) {
	switch act {
	case actClose:
		return m, nil
	case actOpenProject:
		m.notice = ""
		m.wantProject = payload
		m.project = payload
		var cmds []tea.Cmd
		if m.client != nil {
			cmds = append(cmds,
				sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgProject, Text: payload}),
				func() tea.Msg {
					// resume the newest session of this project, or start fresh
					return fetchSessionsForProject(m.addr, m.token, payload)
				},
			)
		}
		return m, tea.Batch(cmds...)
	case actOpenProjectCreate:
		return m, func() tea.Msg {
			err := postJSON("POST", restURL(m.addr, "/api/projects"), m.token,
				map[string]string{"name": input, "machine": m.machineDefault(), "workdir": m.workdirDefault()})
			return actionDoneMsg{err}
		}
	case actDeleteProjectExec:
		return m, func() tea.Msg {
			// find id by name via list
			var list []protocol.Project
			if err := getJSON(restURL(m.addr, "/api/projects"), m.token, &list); err != nil {
				return actionDoneMsg{err}
			}
			for _, p := range list {
				if p.Name == payload {
					return actionDoneMsg{postJSON("DELETE", restURL(m.addr, fmt.Sprintf("/api/projects/%d", p.ID)), m.token, nil)}
				}
			}
			return actionDoneMsg{fmt.Errorf("프로젝트를 찾을 수 없습니다: %s", payload)}
		}
	case actConnectInput, actConnectExec:
		fields := strings.Fields(input)
		if len(fields) < 2 {
			m.notice = "사용법: 주소:포트 토큰"
			return m, nil
		}
		m.addr, m.token = fields[0], fields[1]
		m.connected = false
		return m, dialServer(m.addr, m.token)
	case actDisconnect:
		if m.client != nil {
			m.client.close()
		}
		m.client = nil
		m.connected = false
		m.busy = false
		return m, nil
	case actRegisterMachineExec:
		f := strings.Fields(input)
		if len(f) < 3 {
			m.notice = "사용법: 이름 호스트 [포트] 사용자"
			return m, nil
		}
		machine := protocol.Machine{Name: f[0], Host: f[1], User: f[len(f)-1], Port: 22}
		if len(f) >= 4 {
			fmt.Sscanf(f[2], "%d", &machine.Port)
		}
		return m, func() tea.Msg {
			return actionDoneMsg{postJSON("POST", restURL(m.addr, "/api/machines"), m.token, machine)}
		}
	case actSetModel:
		return m, func() tea.Msg {
			err := postJSON("PUT", restURL(m.addr, "/api/roles/agent-chat"), m.token,
				map[string]string{"provider": m.provider, "model": payload})
			if err == nil {
				m.model = payload
			}
			return actionDoneMsg{err}
		}
	case actRefreshModels:
		return m, fetchModels(m.addr, m.token)
	case actSetGoalExec:
		if m.client != nil {
			m.goal = input
			return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSetGoal, Text: input})
		}
		m.notice = "서버에 연결되어 있지 않습니다"
		return m, nil
	case actClearGoal:
		m.goal = ""
		if m.client != nil {
			return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgSetGoal, Text: ""})
		}
		return m, nil
	case actResumeSession:
		for _, s := range m.sessionIDs {
			if s.ID == payload {
				m.currentSession = s.ID
			}
		}
		if m.client != nil {
			return m, sendCmd(m.client, protocol.ClientMsg{Type: protocol.MsgResume, SessionID: payload})
		}
		return m, nil
	}
	return m, nil
}

func sendCmd(c *wsClient, msg protocol.ClientMsg) tea.Cmd {
	return func() tea.Msg {
		if err := c.send(msg); err != nil {
			return wsEventMsg{ev: protocol.Event{Type: protocol.EvError, Error: err.Error()}}
		}
		return nil
	}
}

// menu builders -------------------------------------------------------

func menuProjects(list []protocol.Project, current string) *menu {
	items := []menuItem{}
	for _, p := range list {
		mark := ""
		if p.Name == current {
			mark = " · 현재"
		}
		items = append(items, menuItem{label: p.Name, desc: p.Workdir + "@" + p.Machine + mark, action: actOpenProject, payload: p.Name})
	}
	items = append(items,
		menuItem{label: "＋ 새 프로젝트", action: actNewProjectInput},
		menuItem{label: "✕ 삭제…", action: actDeleteProjectConfirm, payload: current},
	)
	return newMenu("프로젝트", items)
}

func menuServer(connected bool, machines []protocol.Machine) *menu {
	items := []menuItem{
		{label: "연결…", desc: "주소:포트 토큰", action: actConnectInput},
	}
	if connected {
		items[0].desc = "주소:포트 토큰 (현재 연결됨)"
		items = append(items, menuItem{label: "연결 끊기", action: actDisconnect})
	}
	for _, mc := range machines {
		items = append(items, menuItem{label: "▤ " + mc.Name, desc: mc.User + "@" + mc.Host + " · " + mc.State})
	}
	items = append(items, menuItem{label: "▤ 기기 등록…", desc: "이름 호스트 포트 사용자", action: actRegisterMachineInput})
	return newMenu("서버", items)
}

func menuModels(models []string, current string) *menu {
	items := []menuItem{}
	for _, m := range models {
		mark := ""
		if m == current {
			mark = " · 현재"
		}
		items = append(items, menuItem{label: m, desc: mark, action: actSetModel, payload: m})
	}
	items = append(items, menuItem{label: "↻ 새로고침", action: actRefreshModels})
	return newMenu("모델", items)
}

func menuGoal(goal string) *menu {
	items := []menuItem{
		{label: "목표 설정…", desc: goal, action: actSetGoalInput},
	}
	if goal != "" {
		items = append(items, menuItem{label: "목표 지우기", action: actClearGoal})
	}
	return newMenu("목표", items)
}

func menuSessions(sessions []protocol.SessionInfo) *menu {
	items := []menuItem{}
	for _, s := range sessions {
		label := s.Name
		if label == "" {
			label = s.ID
		}
		items = append(items, menuItem{label: label, desc: s.UpdatedAt.Format("01-02 15:04"), action: actResumeSession, payload: s.ID})
	}
	return newMenu("세션 이어하기", items)
}

// render draws the fullscreen menu inside width×height.
func (mu *menu) render(width, height int) string {
	mu.clampSel()
	var body []string
	body = append(body, titleStyle.Render(mu.title), "")

	switch mu.mode {
	case menuInput:
		body = append(body, hintStyle.Render(mu.prompt), "", mu.input.View())
	case menuConfirm:
		body = append(body, errStyle.Render(mu.prompt))
	default:
		for i, it := range mu.items {
			label := it.label
			if it.desc != "" {
				gap := width - 6 - lipgloss.Width(label) - lipgloss.Width(it.desc)
				if gap < 2 {
					gap = 2
				}
				label = label + strings.Repeat(" ", gap) + hintStyle.Render(it.desc)
			}
			label = padRight(label, width-4)
			if i == mu.sel {
				label = popupSelStyle.Render(label)
			}
			body = append(body, truncate(label, width-2))
		}
		body = append(body, "", hintStyle.Render("↑↓ 이동 · Enter 선택 · Esc 닫기"))
	}

	content := strings.Join(body, "\n")
	return lipgloss.NewStyle().Padding(0, 1).Render(content)
}
