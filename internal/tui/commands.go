package tui

import "strings"

// command describes one slash command shown in the popup.
// Descriptions come from the active language table.
type command struct {
	name  string
	alias string // optional short form shown in the popup
}

var commands = []command{
	{"/project", ""},
	{"/new", ""},
	{"/resume", ""},
	{"/stop", "esc"},
	{"/server", ""},
	{"/exit", ""},
	{"/skill", ""},
	{"/model", ""},
	{"/btw", ""},
	{"/update", ""},
	{"/goal", ""},
	{"/queue", "/q"},
	{"/usage", ""},
	{"/git", ""},
	{"/mcp", ""},
	{"/compact", ""},
	{"/rename", ""},
	{"/init", ""},
	{"/language", ""},
	{"/mouse", ""},
}

var gitSubcommands = []string{"branch", "fork", "commit", "log", "status"}

// popupItem is one row of the command popup.
type popupItem struct {
	left  string // completion text
	name  string // display name column
	alias string // display shortcut column
	desc  string
}

// candidates derives popup rows from the current input.
func (m Model) candidates() []popupItem {
	v := m.msgIn.Value()
	if !strings.HasPrefix(v, "/") {
		return nil
	}

	if arg, ok := strings.CutPrefix(v, "/language "); ok {
		if arg == "" {
			items := make([]popupItem, 0, len(langOrder))
			for _, l := range langOrder {
				items = append(items, popupItem{left: "/language " + string(l), name: string(l), desc: langNames[l]})
			}
			return items
		}
		if strings.Contains(arg, " ") {
			return nil
		}
		var items []popupItem
		for _, l := range langOrder {
			if strings.HasPrefix(string(l), arg) {
				items = append(items, popupItem{left: "/language " + string(l), name: string(l), desc: langNames[l]})
			}
		}
		return items
	}

	if arg, ok := strings.CutPrefix(v, "/git "); ok {
		if arg == "" {
			items := make([]popupItem, 0, len(gitSubcommands))
			for _, s := range gitSubcommands {
				items = append(items, popupItem{left: "/git " + s, name: s, desc: ""})
			}
			return items
		}
		if strings.Contains(arg, " ") {
			return nil
		}
		var items []popupItem
		for _, s := range gitSubcommands {
			if strings.HasPrefix(s, arg) {
				items = append(items, popupItem{left: "/git " + s, name: s, desc: ""})
			}
		}
		return items
	}

	if strings.Contains(v, " ") {
		return nil // command already complete, typing arguments
	}
	t := m.t()
	items := make([]popupItem, 0, len(commands))
	for _, c := range commands {
		if strings.HasPrefix(c.name, v) || (c.alias != "" && strings.HasPrefix(c.alias, v)) {
			items = append(items, popupItem{left: c.name, name: c.name, alias: c.alias, desc: t.CmdDescs[c.name]})
		}
	}
	return items
}
