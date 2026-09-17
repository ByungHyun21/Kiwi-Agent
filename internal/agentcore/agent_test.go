package agentcore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ByungHyun21/Kiwi-Agent/internal/exec"
	"github.com/ByungHyun21/Kiwi-Agent/internal/llm"
	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
)

// scriptLLM serves a fixed sequence of streaming responses.
func scriptLLM(t *testing.T, scripts [][]string) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	idx := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		i := idx
		idx++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		if i >= len(scripts) {
			i = len(scripts) - 1
		}
		for _, c := range scripts[i] {
			w.Write([]byte("data: " + c + "\n\n"))
			fl.Flush()
		}
	})
	return httptest.NewServer(mux)
}

// localRunner executes kiwi-exec operations directly against a temp dir.
type localRunner struct{ root string }

func (l localRunner) Run(_ context.Context, _ protocol.Machine, workdir string, argv []string, payload []byte) protocol.ExecResult {
	// reuse execcli semantics against the real filesystem
	res := runLocal(workdir, argv, payload)
	return res
}

func runLocal(workdir string, argv []string, payload []byte) protocol.ExecResult {
	cmd, rest := argv[0], argv[1:]
	switch cmd {
	case "read":
		data, err := os.ReadFile(filepath.Join(workdir, rest[0]))
		if err != nil {
			return protocol.ExecResult{OK: false, Code: "noent", Message: err.Error()}
		}
		return protocol.ExecResult{OK: true, Data: string(data)}
	case "write":
		full := filepath.Join(workdir, rest[0])
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, payload, 0o644); err != nil {
			return protocol.ExecResult{OK: false, Code: "error", Message: err.Error()}
		}
		return protocol.ExecResult{OK: true}
	case "ls":
		entries, _ := os.ReadDir(filepath.Join(workdir, rest[0]))
		var b strings.Builder
		for _, e := range entries {
			b.WriteString(e.Name() + "\n")
		}
		return protocol.ExecResult{OK: true, Data: b.String()}
	}
	return protocol.ExecResult{OK: false, Code: "badrequest"}
}

var _ exec.Runner = localRunner{}

func TestTurnWritesFileThroughTools(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir + "/db.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.SaveMachine(protocol.Machine{Name: "local", Host: "x", User: "u"})
	p, _ := st.CreateProject(protocol.Project{Name: "kiwi_test", Machine: "local", Workdir: dir})
	sess, _ := st.NewSession(p.ID, "")

	html := "<!DOCTYPE html>\n<html><body>kiwi</body></html>\n"
	callArgs, _ := json.Marshal(map[string]string{"path": "index.html", "content": html})
	srv := scriptLLM(t, [][]string{
		{ // first response: reasoning + tool call
			`{"choices":[{"delta":{"reasoning_content":"파일을 만들어야 한다"}}]}`,
			fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"%s"}}]}}]}`, escapeJSON(string(callArgs))),
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}`,
		},
		{ // second response: final summary
			`{"choices":[{"delta":{"content":"index.html 생성 완료"}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":150,"completion_tokens":10}}`,
		},
	})
	defer srv.Close()

	var events []protocol.Event
	agent := &Agent{
		LLM:     llm.New(srv.URL+"/v1", "", "test"),
		Runner:  localRunner{},
		Machine: protocol.Machine{Name: "local"},
		Workdir: dir,
		Store:   st,
		Emit:    func(e protocol.Event) { events = append(events, e); t.Logf("EV %s %s %.80s", e.Type, e.Name, e.Result) },
	}

	if err := agent.Turn(context.Background(), sess.ID, "index.html 만들어"); err != nil {
		t.Fatal(err)
	}

	// file actually written
	if got, err := os.ReadFile(filepath.Join(dir, "index.html")); err != nil || string(got) != html {
		t.Fatalf("file = %q err=%v", got, err)
	}
	// raw events surfaced
	var sawReasoning, sawDelta, sawCall, sawResult bool
	for _, e := range events {
		switch e.Type {
		case protocol.EvReasoning:
			sawReasoning = true
		case protocol.EvDelta:
			sawDelta = true
		case protocol.EvToolCall:
			sawCall = e.Name == "write_file"
		case protocol.EvToolResult:
			// new-file writes show the full content as a diff
			sawResult = strings.Contains(e.Result, "+++ index.html") && strings.Contains(e.Result, "+ <html>")
		}
	}
	if !sawReasoning || !sawDelta || !sawCall || !sawResult {
		t.Fatalf("events incomplete: %+v", events)
	}
	// history persisted: user, assistant(toolcall), tool, assistant(final)
	msgs, _ := st.Messages(sess.ID)
	if len(msgs) != 4 {
		t.Fatalf("messages = %d, want 4: %+v", len(msgs), msgs)
	}
	// usage accumulated
	got, _ := st.Session(sess.ID)
	if got.PromptTokens != 250 || got.CompletionTokens != 30 {
		t.Fatalf("usage = %+v", got)
	}
}

func TestSafePath(t *testing.T) {
	for _, c := range []struct {
		p  string
		ok bool
	}{
		{"index.html", true},
		{"css/main.css", true},
		{"/etc/passwd", false},
		{"../outside.txt", false},
		{"a/../../b", false},
		{"", false},
	} {
		if safePath(c.p) != c.ok {
			t.Fatalf("safePath(%q) = %v, want %v", c.p, safePath(c.p), c.ok)
		}
	}
}
func TestUnifiedDiff(t *testing.T) {
	oldT := "a\nb\nc\n"
	newT := "a\nx\nc\n"
	d := UnifiedDiff("f.txt", oldT, newT)
	if !strings.Contains(d, "- b") || !strings.Contains(d, "+ x") {
		t.Fatalf("diff = %q", d)
	}
}

func escapeJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

func TestShouldCompactThreshold(t *testing.T) {
	dir := t.TempDir()
	st, _ := store.Open(dir + "/db.sqlite")
	defer st.Close()
	st.SetSetting("compact_threshold", "80")
	a := &Agent{Store: st}
	if !a.ShouldCompact(80, 100) {
		t.Fatal("80% should trigger")
	}
	if a.ShouldCompact(79, 100) {
		t.Fatal("79% should not trigger")
	}
}
