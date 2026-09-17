package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// rightPanel renders the sidebar content without a box: it sits right of a
// vertical rule that spans from the top of the window to the input divider.
func (m Model) rightPanel(height, width int) string {
	t := m.t()
	statusW := max(lipgloss.Width(t.ModelLabel),
		max(lipgloss.Width(t.MachineLabel),
			max(lipgloss.Width(t.ContextLabel), lipgloss.Width(t.GoalLabel)))) + 2

	sections := []string{
		"", "", // keep clear of the header row
		labelStyle.Render(t.ProjectLabel),
		m.projectLine(width - 2),
		"",
		labelStyle.Render(t.SessionLabel),
		m.sessionLines(width - 4),
		"",
		lipgloss.NewStyle().Foreground(colorLine).Render(strings.Repeat("─", max(4, width-4))),
		"",
		m.statusRow(t.ModelLabel, m.model, statusW, width),
		m.statusRow(t.MachineLabel, m.machine, statusW, width),
		m.statusRow(t.ContextLabel, m.contextGauge(), statusW, width),
		m.statusRow(t.GoalLabel, m.goal, statusW, width),
		"",
		labelStyle.Render(t.TodoLabel),
		m.todoLines(width - 4),
	}
	content := lipgloss.JoinVertical(lipgloss.Left, sections...)
	if height > lipgloss.Height(content) {
		content += strings.Repeat("\n", height-lipgloss.Height(content))
	}
	return lipgloss.NewStyle().
		Width(width).
		PaddingLeft(1).
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

// statusRow renders one "label value" line in the sidebar status block.
func (m Model) statusRow(label, value string, labelW, panelW int) string {
	if value == "" {
		value = mutedStyle.Render(m.t().None)
	}
	value = truncate(value, max(4, panelW-labelW-2))
	return padRight(labelStyle.Render(label), labelW) + value
}

// contextGauge renders an 8-cell usage bar with a percentage.
func (m Model) contextGauge() string {
	pct := 0
	if m.ctxMax > 0 {
		pct = min(100, m.ctxUsed*100/m.ctxMax)
	}
	const cells = 8
	filled := pct * cells / 100
	bar := strings.Repeat("█", filled) + strings.Repeat("░", cells-filled)
	gauge := fmt.Sprintf("%s %3d%%", bar, pct)
	if m.ctxMax == 0 {
		return mutedStyle.Render(gauge)
	}
	return gauge
}

func (m Model) todoLines(width int) string {
	if len(m.todos) == 0 {
		return mutedStyle.Render(m.t().None)
	}
	var b strings.Builder
	for i, todo := range m.todos {
		if i >= maxSessions {
			break
		}
		b.WriteString("· " + truncate(todo, width) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
