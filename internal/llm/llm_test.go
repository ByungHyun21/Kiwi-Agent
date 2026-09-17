package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sse test server emitting reasoning, content, tool call deltas and usage.
func newFakeStream(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		chunks := []string{
			`{"choices":[{"delta":{"reasoning_content":"생각 중..."}}]}`,
			`{"choices":[{"delta":{"content":"안녕"}}]}`,
			`{"choices":[{"delta":{"content":"하세요"}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\"pa"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.html\"}"}}]}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}`,
		}
		for _, c := range chunks {
			w.Write([]byte("data: " + c + "\n\n"))
			fl.Flush()
		}
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"Qwen3.5-9B"},{"id":"gpt-mini"}]}`))
	})
	return httptest.NewServer(mux)
}

func TestStreamChatAssembles(t *testing.T) {
	srv := newFakeStream(t)
	defer srv.Close()
	c := New(srv.URL+"/v1", "", "Qwen3.5-9B")

	var reasoning, content string
	resp, err := c.StreamChat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil,
		func(kind, text string) {
			switch kind {
			case "reasoning":
				reasoning += text
			case "content":
				content += text
			}
		})
	if err != nil {
		t.Fatal(err)
	}
	if reasoning != "생각 중..." || content != "안녕하세요" {
		t.Fatalf("deltas wrong: %q %q", reasoning, content)
	}
	if resp.Content != "안녕하세요" || resp.Reasoning != "생각 중..." {
		t.Fatalf("assembled wrong: %+v", resp)
	}
	if len(resp.ToolCalls) != 1 || resp.ToolCalls[0].Name != "write_file" ||
		resp.ToolCalls[0].Args != `{"path":"a.html"}` || resp.ToolCalls[0].ID != "call_1" {
		t.Fatalf("tool calls wrong: %+v", resp.ToolCalls)
	}
	if resp.Usage.PromptTokens != 120 || resp.Usage.CompletionTokens != 45 {
		t.Fatalf("usage wrong: %+v", resp.Usage)
	}
	if resp.Finish != "tool_calls" {
		t.Fatalf("finish = %q", resp.Finish)
	}
}

func TestListModels(t *testing.T) {
	srv := newFakeStream(t)
	defer srv.Close()
	c := New(srv.URL+"/v1", "", "m")
	ids, err := c.ListModels(context.Background())
	if err != nil || len(ids) != 2 || ids[0] != "Qwen3.5-9B" {
		t.Fatalf("models = %v err=%v", ids, err)
	}
}

func TestCompleteNonStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"요약 완료"}}]}`))
	}))
	defer srv.Close()
	c := New(srv.URL+"/v1", "", "m")
	got, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "요약해"}})
	if err != nil || got != "요약 완료" {
		t.Fatalf("complete = %q err=%v", got, err)
	}
}
