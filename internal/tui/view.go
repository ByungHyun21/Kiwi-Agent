package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// View implements tea.Model.
func (m Model) View() string { return m.viewMain() }

func (m Model) statusBadge() string {
	if m.connected {
		return badgeOn.Render(m.t().Connected)
	}
	return badgeOff.Render(m.t().Disconnected)
}

// spinnerLine is the busy indicator shown above the input.
func (m Model) spinnerLine() string {
	if !m.busy {
		return ""
	}
	label := " 진행 중…"
	if m.curTool != "" {
		label = " 진행 중… ⚒ " + m.curTool
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color("#a8c17a")).Bold(true).
		Render(spinnerFrames[m.spinner] + label)
}

func (m Model) viewMain() string {
	l := m.layoutOf()

	header := lipgloss.JoinHorizontal(lipgloss.Left,
		titleStyle.Render("KIWI"),
		"  ",
		m.statusBadge(),
	)

	// conversation or fullscreen menu, right of the vertical rule;
	// force the full column width even when the transcript is empty
	var left string
	if m.menu != nil {
		left = m.menu.render(l.leftW, l.bodyH)
	} else {
		left = m.renderTranscript(l.leftW, l.bodyH)
	}
	left = lipgloss.NewStyle().Width(l.leftW).MaxHeight(l.bodyH).Render(left)

	leftCol := lipgloss.JoinVertical(lipgloss.Left, header, "", left)
	leftCol = lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, true, false, false).
		BorderForeground(colorLine).
		Render(leftCol)

	right := m.rightPanel(l.bodyH+2, l.panelW)
	body := lipgloss.JoinHorizontal(lipgloss.Top, leftCol, right)

	divider := lipgloss.NewStyle().
		Foreground(colorLine).
		Render(strings.Repeat("─", max(10, l.width-2)))

	t := m.t()
	helpLeft := hintStyle.Render(t.HelpLeft)
	helpRight := hintStyle.Render(t.HelpRight)
	help := padRight(helpLeft, max(10, l.width-2)-lipgloss.Width(helpRight)) + helpRight

	cols := []string{
		body,
		divider,
		m.msgIn.View(),
	}
	if sp := m.spinnerLine(); sp != "" {
		cols = append(cols, sp)
	}
	if l.popupLines > 0 {
		cols = append(cols, m.popupView(l.width))
	}
	cols = append(cols, m.notice, help)

	return lipgloss.JoinVertical(lipgloss.Left, cols...)
}
