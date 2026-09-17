package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// layout is the single source of view geometry.
type layout struct {
	width      int
	height     int
	panelW     int // sidebar width
	leftW      int // transcript column width
	bodyH      int // transcript column height
	popupLines int // command popup height, 0 when closed
}

// layoutOf computes the current geometry once for all consumers.
func (m Model) layoutOf() layout {
	w, h := m.width, m.height
	if w <= 0 {
		w = 80
	}
	if h <= 0 {
		h = 24
	}
	l := layout{width: w, height: h}
	l.panelW = panelWidth(w)
	l.leftW = w - l.panelW - 3 // vertical rule + sidebar padding
	if l.leftW < 4 {
		l.leftW = 4
	}
	popup := m.popupView(w)
	l.popupLines = lineCount(popup)

	chrome := 6 + l.popupLines // header+blank, divider, input, notice, help
	if m.busy {
		chrome++ // spinner line
	}
	l.bodyH = h - chrome
	if l.bodyH < 4 {
		l.bodyH = 4
	}
	return l
}

func lineCount(s string) int {
	if s == "" {
		return 0
	}
	n := 1
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			n++
		}
	}
	return n
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
		m.transcript = append(m.transcript, tline{kind: lineError, text: "서버 연결이 끊겼습니다"})
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
		m.transcript = append(m.transcript, tline{kind: lineNotice, text: "이 프로젝트의 세션이 없습니다. /new 로 시작하세요"})
		return m, nil

	case usageMsg:
		if msg.err != nil {
			m.notice = "사용량 조회 실패: " + msg.err.Error()
			return m, nil
		}
		m.tokens = int(msg.prompt + msg.completion)
		m.transcript = append(m.transcript, tline{kind: lineNotice,
			text: fmt.Sprintf("세션 토큰 사용량 — 프롬프트 %d + 완성 %d = %d", msg.prompt, msg.completion, msg.prompt+msg.completion)})
		return m, nil

	case actionDoneMsg:
		if msg.err != nil {
			m.notice = msg.err.Error()
		}
		return m, nil

	case connectResultMsg:
		if msg.err != nil {
			m.connected = false
			m.transcript = append(m.transcript, tline{kind: lineError, text: "연결 실패: " + msg.err.Error()})
			return m, nil
		}
		m.client = msg.client
		m.connected = true
		saveServer(m.addr, m.token)
		m.transcript = append(m.transcript, tline{kind: lineNotice, text: "서버에 연결되었습니다"})
		return m, tea.Batch(m.client.readOne(), m.afterConnect())

	case tea.KeyMsg:
		if m.menu != nil {
			return m.updateMenu(msg)
		}
		return m.updateKeys(msg)

	case tea.MouseMsg:
		l := m.layoutOf()
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.scrollBy(l.leftW, l.bodyH, -3)
		case tea.MouseButtonWheelDown:
			m.scrollBy(l.leftW, l.bodyH, 3)
		}
		return m, nil
	}
	return m, nil
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

	l := m.layoutOf()
	switch msg.Type {
	case tea.KeyPgUp:
		m.scrollBy(l.leftW, l.bodyH, -5)
		return m, nil
	case tea.KeyPgDown:
		m.scrollBy(l.leftW, l.bodyH, 5)
		return m, nil
	case tea.KeyCtrlC:
		// clear the input line; quitting is /exit
		m.msgIn.SetValue("")
		m.notice = ""
		return m, nil
	case tea.KeyEsc:
		// /stop surface behavior: consume quietly
		m.msgIn.SetValue("")
		m.notice = ""
		return m, nil
	case tea.KeyEnter:
		return m.runCommand(m.msgIn.Value())
	}
	var cmd tea.Cmd
	m.msgIn, cmd = m.msgIn.Update(msg)
	m.sanitizeInput()
	m.popupGone = false
	m.popupSel = m.clampPopupSel(len(m.candidates()))
	return m, cmd
}
