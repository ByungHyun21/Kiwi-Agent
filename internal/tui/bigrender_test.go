package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestBigTranscriptRender(t *testing.T) {
	m := New()
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m2 := mm.(Model)
	m2.transcript = append(m2.transcript, tline{kind: lineUser, text: "랜딩 페이지 만들어"})
	long := strings.Repeat("이것은 긴 한국형 랜딩 페이지의 본문 단락입니다. 섹션 설명이 계속 이어집니다. ", 40)
	m2.transcript = append(m2.transcript,
		tline{kind: lineReasoning, text: long},
		tline{kind: lineTool, text: `write_file {"path":"landing.html","content":"...12KB..."}`},
		tline{kind: lineResult, text: "landing.html 생성됨 (12618 bytes)"},
		tline{kind: lineAssistant, text: long},
	)
	view := m2.View()
	lines := strings.Split(view, "\n")
	if len(lines) != 40 {
		t.Fatalf("frame height = %d, want 40", len(lines))
	}
	content := 0
	for _, l := range lines {
		c := stripAnsiForTest(l)
		if strings.Contains(c, "랜딩") || strings.Contains(c, "write_file") || strings.Contains(c, "생성됨") {
			content++
		}
	}
	if content == 0 {
		t.Fatal("no transcript content rendered at all")
	}
	t.Logf("content lines visible: %d / 40", content)
}

func stripAnsiForTest(s string) string {
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
