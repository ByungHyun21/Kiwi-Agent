package tui

import (
	"strings"
	"sync"

	"github.com/charmbracelet/glamour"
)

// mdRenderers caches one glamour renderer per wrap width.
var (
	mdMu        sync.Mutex
	mdRenderers = map[int]*glamour.TermRenderer{}
)

func mdRenderer(width int) *glamour.TermRenderer {
	mdMu.Lock()
	defer mdMu.Unlock()
	if r, ok := mdRenderers[width]; ok {
		return r
	}
	r, err := glamour.NewTermRenderer(glamour.WithStandardStyle("dark"), glamour.WithWordWrap(width))
	if err != nil {
		return nil
	}
	if len(mdRenderers) > 4 { // keep the cache tiny; widths rarely change
		mdRenderers = map[int]*glamour.TermRenderer{}
	}
	mdRenderers[width] = r
	return r
}

// renderMarkdown renders one message to terminal display lines. Returns
// nil when rendering fails; callers fall back to plain text.
func renderMarkdown(width int, text string) []string {
	r := mdRenderer(width)
	if r == nil {
		return nil
	}
	out, err := r.Render(text)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimRight(out, "\n"), "\n")
}
