// Package llm is a minimal OpenAI-compatible chat client with streaming,
// tool calling and usage accounting, sufficient for kiwi-server.
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// ToolCall is one tool invocation requested by the model.
type ToolCall struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Args string `json:"args"` // raw JSON string
}

// Message is one conversation entry.
type Message struct {
	Role       string     `json:"role"` // system | user | assistant | tool
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"-"`              // assistant: calls to run
	ToolCallID string     `json:"-"`              // tool: which call
	Name       string     `json:"name,omitempty"` // tool name
}

// Tool defines one function the model may call.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// Usage is token accounting from one completion.
type Usage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

// Response is the assembled result of one completion.
type Response struct {
	Content   string
	Reasoning string
	ToolCalls []ToolCall
	Usage     Usage
	Finish    string
}

type chatMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	ToolCalls  []chatCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type chatCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function chatFunction `json:"function"`
}

type chatFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type chatTool struct {
	Type     string       `json:"type"`
	Function chatToolFunc `json:"function"`
}

type chatToolFunc struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// Client talks to one OpenAI-compatible endpoint.
type Client struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

// New builds a client for a base URL like http://localhost:9998/v1.
func New(baseURL, apiKey, model string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, Model: model, HTTP: http.DefaultClient}
}

// StreamChat calls chat/completions with stream=true, invoking onDelta for
// every reasoning ("reasoning") and content ("content") chunk, and returns
// the assembled response.
func (c *Client) StreamChat(ctx context.Context, msgs []Message, tools []Tool, onDelta func(kind, name, text string)) (*Response, error) {
	body := map[string]any{
		"model":          c.Model,
		"messages":       convertMessages(msgs),
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if len(tools) > 0 {
		body["tools"] = convertTools(tools)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		buf.ReadFrom(resp.Body)
		return nil, fmt.Errorf("llm: %s: %s", resp.Status, strings.TrimSpace(buf.String()))
	}

	var out Response
	calls := map[int]*ToolCall{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if u := chunk.Usage; u != nil {
			out.Usage.PromptTokens = u.PromptTokens
			out.Usage.CompletionTokens = u.CompletionTokens
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		ch := chunk.Choices[0]
		if ch.FinishReason != nil {
			out.Finish = *ch.FinishReason
		}
		if ch.Delta.ReasoningContent != "" {
			out.Reasoning += ch.Delta.ReasoningContent
			if onDelta != nil {
				onDelta("reasoning", "", ch.Delta.ReasoningContent)
			}
		}
		if ch.Delta.Content != "" {
			out.Content += ch.Delta.Content
			if onDelta != nil {
				onDelta("content", "", ch.Delta.Content)
			}
		}
		for _, tc := range ch.Delta.ToolCalls {
			call, ok := calls[tc.Index]
			if !ok {
				call = &ToolCall{ID: tc.ID, Name: tc.Function.Name}
				calls[tc.Index] = call
			}
			if tc.ID != "" {
				call.ID = tc.ID
			}
			if tc.Function.Name != "" {
				call.Name = tc.Function.Name
			}
			if tc.Function.Arguments != "" {
				call.Args += tc.Function.Arguments
				if onDelta != nil {
					onDelta("tool_args", call.Name, tc.Function.Arguments)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	for i := range len(calls) {
		if call, ok := calls[i]; ok && call.Name != "" {
			out.ToolCalls = append(out.ToolCalls, *call)
		}
	}
	return &out, nil
}

// Complete is a non-streaming convenience call (used for compaction).
func (c *Client) Complete(ctx context.Context, msgs []Message) (string, error) {
	body := map[string]any{
		"model":    c.Model,
		"messages": convertMessages(msgs),
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		buf.ReadFrom(resp.Body)
		return "", fmt.Errorf("llm: %s: %s", resp.Status, strings.TrimSpace(buf.String()))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("llm: empty response")
	}
	return out.Choices[0].Message.Content, nil
}

// ListModels returns the model IDs the endpoint advertises.
func (c *Client) ListModels(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("llm: %s", resp.Status)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

func convertMessages(msgs []Message) []chatMessage {
	out := make([]chatMessage, 0, len(msgs))
	for _, m := range msgs {
		cm := chatMessage{Role: m.Role, ToolCallID: m.ToolCallID, Name: m.Name}
		if m.Content != "" {
			cm.Content = m.Content
		} else {
			cm.Content = nil
		}
		if m.Role == "tool" {
			cm.Content = m.Content // tool results are plain strings
		}
		for _, tc := range m.ToolCalls {
			cm.ToolCalls = append(cm.ToolCalls, chatCall{
				ID:       tc.ID,
				Type:     "function",
				Function: chatFunction{Name: tc.Name, Arguments: tc.Args},
			})
		}
		out = append(out, cm)
	}
	return out
}

func convertTools(tools []Tool) []chatTool {
	out := make([]chatTool, 0, len(tools))
	for _, t := range tools {
		out = append(out, chatTool{Type: "function", Function: chatToolFunc{
			Name: t.Name, Description: t.Description, Parameters: t.Parameters,
		}})
	}
	return out
}
