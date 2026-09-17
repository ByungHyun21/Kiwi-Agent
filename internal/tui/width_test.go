package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPanelWidthBounded(t *testing.T) {
	for _, w := range []int{80, 100, 120} {
		m := New()
		mm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: 30})
		m2 := mm.(Model)
		m2.project = "kiwi_test"
		m2.model = "Qwen3.5-9B"
		m2.transcript = append(m2.transcript,
			tline{lineUser, "index.html에 제목이 Kiwi Test인 심플한 랜딩 페이지를 만들어줘. 헤더, 소개 문단, 푸터 포함."},
			tline{lineTool, `write_file {"path":"index.html","content":"<!DOCTYPE html>..."}`},
			tline{lineResult, "index.html 생성됨 (2453 bytes)"},
			tline{lineAssistant, "완성했습니다. 확인해보시면 원하는 페이지가 완성되어 있을 것입니다!"},
		)
		view := m2.View()
		lines := strings.Split(view, "\n")
		maxw := 0
		ruleAt := -1
		for i, line := range lines {
			if lw := len([]rune(stripAnsi(line))); lw > maxw {
				maxw = lw
			}
			if idx := strings.Index(line, "│"); idx >= 0 && ruleAt < 0 && i > 3 {
				ruleAt = idx
			}
		}
		expectRule := w - panelWidth(w) - 3
		if maxw > w {
			t.Fatalf("w=%d: line width %d exceeds terminal", w, maxw)
		}
		if ruleAt != expectRule {
			t.Fatalf("w=%d: rule at %d, want %d", w, ruleAt, expectRule)
		}
	}
}

func stripAnsi(s string) string {
	var b strings.Builder
	esc := false
	for _, r := range s {
		if r == '\x1b' {
			esc = true
			continue
		}
		if esc {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				esc = false
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
