package tui

import "github.com/charmbracelet/lipgloss"

var (
	colorDeep  = lipgloss.Color("#3c5e20")
	colorSoft  = lipgloss.Color("#6b7062")
	colorLabel = lipgloss.Color("#a8c17a") // bright enough for dark terminals
	colorLine  = lipgloss.Color("#c9c4b4")
	colorAmber = lipgloss.Color("#a86a1f")

	titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#ffffff")).
			Background(colorDeep).
			Bold(true).
			Padding(0, 2)

	hintStyle  = lipgloss.NewStyle().Foreground(colorSoft)
	labelStyle = lipgloss.NewStyle().Foreground(colorLabel).Bold(true)
	mutedStyle = lipgloss.NewStyle().Foreground(colorSoft)

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
