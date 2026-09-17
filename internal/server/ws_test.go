package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ByungHyun21/Kiwi-Agent/internal/exec"
	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
)

type noopDB struct{}

func (noopDB) Machine(name string) (protocol.Machine, error) { return protocol.Machine{}, nil }
func (noopDB) SaveHostKey(name, fp string) error             { return nil }
func (noopDB) TouchMachine(name, state string) error         { return nil }

type fakeRunner struct{}

func (fakeRunner) Run(_ context.Context, _ protocol.Machine, _ string, _ []string, _ []byte) protocol.ExecResult {
	return protocol.ExecResult{OK: true, Data: ""}
}

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.SaveMachine(protocol.Machine{Name: "local", Host: "x", User: "u"})
	st.CreateProject(protocol.Project{Name: "kiwi_test", Machine: "local", Workdir: t.TempDir()})
	srv, err := New(st, fakeRunner{})
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	return hs, srv.Token()
}

func dial(t *testing.T, hs *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws?token=" + token
	c, _, err := websocket.Dial(context.Background(), u, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func readEv(t *testing.T, c *websocket.Conn) protocol.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var ev protocol.Event
	json.Unmarshal(data, &ev)
	return ev
}

func TestWSProjectNewFlow(t *testing.T) {
	hs, token := newTestServer(t)
	c := dial(t, hs, token)
	send := func(m protocol.ClientMsg) {
		data, _ := json.Marshal(m)
		c.Write(context.Background(), websocket.MessageText, data)
	}
	readEv(t, c) // hello
	readEv(t, c) // sessions
	readEv(t, c) // state

	send(protocol.ClientMsg{Type: protocol.MsgProject, Text: "kiwi_test"})
	ev := readEv(t, c) // state after project select
	if ev.State == nil || ev.State.Project != "kiwi_test" {
		t.Fatalf("project state = %+v", ev.State)
	}
	readEv(t, c) // sessions refresh for the project

	send(protocol.ClientMsg{Type: protocol.MsgNew})
	ev = readEv(t, c) // sessions refresh (new session listed)
	if ev.Type != protocol.EvSessions || len(ev.Sessions) != 1 {
		t.Fatalf("sessions after new = %+v", ev)
	}
}

func TestWSGoalFlow(t *testing.T) {
	hs, token := newTestServer(t)
	c := dial(t, hs, token)
	readEv(t, c) // hello
	readEv(t, c) // sessions
	readEv(t, c) // state
	send := func(m protocol.ClientMsg) {
		data, _ := json.Marshal(m)
		c.Write(context.Background(), websocket.MessageText, data)
	}

	send(protocol.ClientMsg{Type: protocol.MsgProject, Text: "kiwi_test"})
	readEv(t, c) // state
	readEv(t, c) // sessions
	send(protocol.ClientMsg{Type: protocol.MsgNew})
	readEv(t, c) // sessions (1)
	readEv(t, c) // state

	send(protocol.ClientMsg{Type: protocol.MsgSetGoal, Text: "HTML 만들기"})
	ev := readEv(t, c)
	if ev.State == nil || ev.State.Goal != "HTML 만들기" {
		t.Fatalf("goal state = %+v", ev.State)
	}
}

func TestWSRejectsBadToken(t *testing.T) {
	hs, _ := newTestServer(t)
	u := "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws?token=wrong"
	_, _, err := websocket.Dial(context.Background(), u, nil)
	if err == nil {
		t.Fatal("bad token accepted")
	}
}

var _ exec.Runner = fakeRunner{}
