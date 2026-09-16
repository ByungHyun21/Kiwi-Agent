package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"kiwi-agent/internal/tui"
)

func main() {
	if _, err := tea.NewProgram(tui.New(), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "kiwi:", err)
		os.Exit(1)
	}
}
