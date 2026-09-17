package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ByungHyun21/Kiwi-Agent/internal/agentcore"
	"github.com/ByungHyun21/Kiwi-Agent/internal/llm"
	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

const wsWriteTimeout = 5 * time.Second

// conn is one TUI WebSocket connection with its session runtime.
type conn struct {
	srv    *Server
	mu     sync.Mutex
	ws     *websocket.Conn
	sess   string // current session id
	projID int64  // selected project
	proj   string // selected project name
	busy   bool
	cancel context.CancelFunc
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if token != s.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c := &conn{srv: s, ws: ws}
	defer ws.Close(websocket.StatusNormalClosure, "bye")

	c.send(protocol.Event{Type: protocol.EvHello})
	c.pushSessions(0)
	c.pushState()

	for {
		var msg protocol.ClientMsg
		_, data, err := ws.Read(context.Background())
		if err != nil {
			return
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		c.handle(msg)
	}
}

func (c *conn) send(e protocol.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), wsWriteTimeout)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		log.Printf("ws write: %v", err)
	}
}

func (c *conn) handle(msg protocol.ClientMsg) {
	switch msg.Type {
	case protocol.MsgSend:
		if c.sess == "" {
			c.send(protocol.Event{Type: protocol.EvError, Error: "선택된 세션이 없습니다. /project 또는 /new 로 시작하세요."})
			return
		}
		if c.busy {
			if err := c.srv.store.Enqueue(c.sess, msg.Text); err == nil {
				c.send(protocol.Event{Type: protocol.EvStatus, Name: "queued"})
			}
			return
		}
		c.runTurn(msg.Text)
	case protocol.MsgStop:
		c.mu.Lock()
		cancel := c.cancel
		c.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	case protocol.MsgProject:
		if p, err := c.srv.store.ProjectByName(msg.Text); err == nil {
			c.projID, c.proj = p.ID, p.Name
		}
		c.pushState()
		c.pushSessions(c.projID)
	case protocol.MsgNew:
		pID := c.projID
		if pID == 0 {
			c.send(protocol.Event{Type: protocol.EvError, Error: "먼저 프로젝트를 선택하세요 (/project)."})
			return
		}
		sess, err := c.srv.store.NewSession(pID, msg.Text)
		if err != nil {
			c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
			return
		}
		c.sess = sess.ID
		c.pushSessions(pID)
		c.pushState()
	case protocol.MsgResume:
		if _, err := c.srv.store.Session(msg.SessionID); err != nil {
			c.send(protocol.Event{Type: protocol.EvError, Error: "세션을 찾을 수 없습니다: " + msg.SessionID})
			return
		}
		c.sess = msg.SessionID
		if sess, err := c.srv.store.Session(msg.SessionID); err == nil {
			if p, err := c.srv.store.Project(sess.ProjectID); err == nil {
				c.projID, c.proj = p.ID, p.Name
			}
		}
		c.pushState()
		c.pushSessions(c.projID)
	case protocol.MsgSessions:
		c.pushSessions(c.currentProject())
	case protocol.MsgState:
		c.pushState()
	case protocol.MsgSetGoal:
		if c.sess == "" {
			return
		}
		c.srv.store.SetGoal(c.sess, msg.Text)
		c.pushState()
	case protocol.MsgCompact:
		c.runCompact()
	case protocol.MsgBtw:
		if c.sess == "" {
			return
		}
		c.runBtw(msg.Text)
	}
}

// runTurn executes one agent turn, auto-compacts if needed, drains the queue.
func (c *conn) runTurn(text string) {
	agent, err := c.srv.agentFor(c.sess)
	if err != nil {
		c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
		return
	}
	var lastState *protocol.PanelState
	agent.Emit = func(e protocol.Event) {
		if e.State != nil {
			lastState = e.State
		}
		c.send(e)
	}

	c.mu.Lock()
	c.busy = true
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			c.mu.Lock()
			c.busy = false
			c.cancel = nil
			c.mu.Unlock()
		}()
		if err := agent.Turn(ctx, c.sess, text); err != nil {
			if ctx.Err() == nil {
				c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
			} else {
				c.send(protocol.Event{Type: protocol.EvStatus, Name: "stopped"})
			}
		}
		if lastState != nil {
			checker := agentcore.Agent{Store: c.srv.store}
			if checker.ShouldCompact(lastState.CtxUsed, lastState.CtxMax) {
				if err := agent.Compact(context.Background(), c.sess); err == nil {
					c.send(protocol.Event{Type: protocol.EvStatus, Name: "compacted"})
				}
			}
		}
		c.send(protocol.Event{Type: protocol.EvDone})
		c.send(protocol.Event{Type: protocol.EvStatus, Name: "idle"})
		c.pushSessions(c.currentProject())

		if next, ok, err := c.srv.store.Dequeue(c.sess); err == nil && ok {
			c.runTurn(next)
		}
	}()
}

func (c *conn) runCompact() {
	if c.sess == "" || c.busy {
		return
	}
	agent, err := c.srv.agentFor(c.sess)
	if err != nil {
		c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
		return
	}
	agent.Emit = c.send
	c.mu.Lock()
	c.busy = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			c.busy = false
			c.mu.Unlock()
		}()
		if err := agent.Compact(context.Background(), c.sess); err != nil {
			c.send(protocol.Event{Type: protocol.EvError, Error: "compact 실패: " + err.Error()})
			return
		}
		c.send(protocol.Event{Type: protocol.EvStatus, Name: "compacted"})
		c.pushState()
	}()
}

func (c *conn) runBtw(text string) {
	agent, err := c.srv.agentFor(c.sess)
	if err != nil {
		c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
		return
	}
	history, err := c.srv.store.Messages(c.sess)
	if err != nil {
		return
	}
	msgs := []llm.Message{{Role: "system", Content: agentcore.SystemPrompt()}}
	for _, m := range history {
		msgs = append(msgs, llm.Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, Name: m.Name})
	}
	msgs = append(msgs, llm.Message{Role: "user", Content: "(사이드 질문, 세션 기록에 반영하지 않음) " + text})

	c.mu.Lock()
	c.busy = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			c.busy = false
			c.mu.Unlock()
		}()
		_, err := agent.LLM.StreamChat(context.Background(), msgs, nil, func(kind, text string) {
			if kind == "reasoning" {
				c.send(protocol.Event{Type: protocol.EvReasoning, Text: text})
			} else {
				c.send(protocol.Event{Type: protocol.EvDelta, Text: text})
			}
		})
		if err != nil {
			c.send(protocol.Event{Type: protocol.EvError, Error: err.Error()})
		}
		c.send(protocol.Event{Type: protocol.EvDone})
		c.send(protocol.Event{Type: protocol.EvStatus, Name: "idle"})
	}()
}

func (c *conn) currentProject() int64 {
	if c.sess == "" {
		return 0
	}
	sess, err := c.srv.store.Session(c.sess)
	if err != nil {
		return 0
	}
	return sess.ProjectID
}

func (c *conn) pushSessions(projectID int64) {
	list, err := c.srv.store.Sessions(projectID)
	if err != nil {
		return
	}
	c.send(protocol.Event{Type: protocol.EvSessions, Sessions: list})
}

func (c *conn) pushState() {
	c.send(protocol.Event{Type: protocol.EvState, Session: c.sess, State: c.srv.panelState(c.sess, c.proj)})
}
