package tui

import (
	"regexp"
	"strings"
)

// inputNoise matches terminal replies that leak into the input as text:
// SGR mouse reports (split across reads) and OSC color-query responses
// (e.g. ";rgb:2828/2828/2828"), each with or without the leading escape.
var inputNoise = regexp.MustCompile("(\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\))|(\\x1b?\\[<[0-9;]*[Mm])|(\\]1[01];rgb:[0-9a-fA-F/]{7,})|(;rgb:[0-9a-fA-F/]{7,})")

// sanitizeInput strips leaked terminal control replies from the input.
func (m *Model) sanitizeInput() {
	v := m.msgIn.Value()
	if !strings.ContainsAny(v, "[<;") && !strings.ContainsRune(v, 0x1b) {
		return
	}
	m.msgIn.SetValue(inputNoise.ReplaceAllString(v, ""))
}
