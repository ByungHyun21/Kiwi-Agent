package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

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
