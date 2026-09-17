package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

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
	// popupStyle has PaddingLeft(1) and Width includes padding, so rows
	contentW := rowW - 1

	// three columns: command, shortcut, description
	nameW := 0
	aliasW := 0
	for _, it := range items {
		nameW = max(nameW, lipgloss.Width(it.name))
		aliasW = max(aliasW, lipgloss.Width(it.alias))
	}
	nameW += 2
	aliasW += 2

	var rows []string
	for i, it := range visible {
		idx := start + i
		var row string
		if idx == sel {
			// plain row only: nested ANSI resets would drop the background
			row = padRight(it.name, nameW) + padRight(it.alias, aliasW) + it.desc
			row = popupSelStyle.Render(truncate(padRight(row, contentW), contentW))
		} else {
			alias := popupAliasStyle.Render(padRight(it.alias, aliasW))
			row = padRight(it.name, nameW) + alias + it.desc
			row = truncate(padRight(row, contentW), contentW)
		}
		rows = append(rows, row)
	}

	return popupStyle.
		Width(rowW).
		MaxHeight(popupMaxRows + 2).
		Render(strings.Join(rows, "\n"))
}
