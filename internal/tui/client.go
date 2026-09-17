package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/coder/websocket"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// wsEventMsg wraps one server event for the bubbletea loop.
type wsEventMsg struct{ ev protocol.Event }
type connectResultMsg struct {
	client *wsClient
	err    error
}
type roleMsg struct {
	provider, model string
	err             error
}
type sessionsForProjectMsg struct {
	sessions []protocol.SessionInfo
	err      error
}
type wsClosedMsg struct{}
type tickMsg struct{}

// wsClient is the connection to kiwi-server.
type wsClient struct {
	conn *websocket.Conn
}

func wsURL(addr, token string) string {
	if !strings.Contains(addr, "://") {
		addr = "ws://" + addr
	}
	u, err := url.Parse(addr)
	if err != nil {
		return addr
	}
	u.Path = "/ws"
	u.RawQuery = "token=" + url.QueryEscape(token)
	return u.String()
}

func dialServer(addr, token string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, wsURL(addr, token), nil)
		if err != nil {
			return connectResultMsg{err: err}
		}
		return connectResultMsg{client: &wsClient{conn: conn}}
	}
}

func fetchRole(addr, token string) tea.Cmd {
	return func() tea.Msg {
		var out struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		}
		err := getJSON(restURL(addr, "/api/roles/agent-chat"), token, &out)
		return roleMsg{provider: out.Provider, model: out.Model, err: err}
	}
}

// fetchSessionsForProject lists sessions of a project by name.
func fetchSessionsForProject(addr, token, projectName string) tea.Msg {
	var projects []protocol.Project
	if err := getJSON(restURL(addr, "/api/projects"), token, &projects); err != nil {
		return sessionsForProjectMsg{err: err}
	}
	for _, p := range projects {
		if p.Name != projectName {
			continue
		}
		var sessions []protocol.SessionInfo
		u := restURL(addr, "/api/sessions?project="+url.PathEscape(fmt.Sprint(p.ID)))
		if err := getJSON(u, token, &sessions); err != nil {
			return sessionsForProjectMsg{err: err}
		}
		return sessionsForProjectMsg{sessions: sessions}
	}
	return sessionsForProjectMsg{err: fmt.Errorf("프로젝트를 찾을 수 없습니다: %s", projectName)}
}

// readOne returns a cmd reading the next event, chaining itself.
func (c *wsClient) readOne() tea.Cmd {
	if c == nil {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 24*time.Hour)
		defer cancel()
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			return wsClosedMsg{}
		}
		var ev protocol.Event
		if err := json.Unmarshal(data, &ev); err != nil {
			return nil
		}
		return wsEventMsg{ev: ev}
	}
}

func (c *wsClient) send(m protocol.ClientMsg) error {
	if c == nil {
		return fmt.Errorf("not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, _ := json.Marshal(m)
	return c.conn.Write(ctx, websocket.MessageText, data)
}

func (c *wsClient) close() {
	if c != nil {
		c.conn.CloseNow()
	}
}

// ---- REST helpers ----

type projectsMsg struct {
	list []protocol.Project
	err  error
}
type modelsMsg struct {
	list []string
	err  error
}
type machinesMsg struct {
	list []protocol.Machine
	err  error
}
type usageMsg struct {
	prompt, completion int64
	err                error
}
type actionDoneMsg struct{ err error }

func restURL(addr, path string) string {
	if strings.Contains(addr, "://") {
		addr = strings.TrimPrefix(strings.TrimPrefix(addr, "ws://"), "http://")
	}
	return "http://" + strings.TrimSuffix(addr, "/") + path
}

func fetchProjects(addr, token string) tea.Cmd {
	return func() tea.Msg {
		var list []protocol.Project
		err := getJSON(restURL(addr, "/api/projects"), token, &list)
		return projectsMsg{list: list, err: err}
	}
}

func fetchModels(addr, token string) tea.Cmd {
	return func() tea.Msg {
		var list []string
		err := getJSON(restURL(addr, "/api/models"), token, &list)
		return modelsMsg{list: list, err: err}
	}
}

func fetchMachines(addr, token string) tea.Cmd {
	return func() tea.Msg {
		var list []protocol.Machine
		err := getJSON(restURL(addr, "/api/machines"), token, &list)
		return machinesMsg{list: list, err: err}
	}
}

func fetchUsage(addr, token, sessionID string) tea.Cmd {
	return func() tea.Msg {
		var out struct {
			PromptTokens     int64 `json:"promptTokens"`
			CompletionTokens int64 `json:"completionTokens"`
		}
		err := getJSON(restURL(addr, "/api/usage?session="+url.QueryEscape(sessionID)), token, &out)
		return usageMsg{prompt: out.PromptTokens, completion: out.CompletionTokens, err: err}
	}
}

func getJSON(u, token string, v any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func postJSON(method, u, token string, body any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, method, u, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
