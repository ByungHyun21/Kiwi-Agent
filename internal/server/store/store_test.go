package store

import (
	"testing"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func localMachine() protocol.Machine {
	return protocol.Machine{Name: "local", Host: "localhost", Port: 22, User: "tester"}
}

func TestTokenStable(t *testing.T) {
	s := open(t)
	a, err := s.Token()
	if err != nil || a == "" {
		t.Fatal(a, err)
	}
	b, _ := s.Token()
	if a != b {
		t.Fatalf("token changed: %q vs %q", a, b)
	}
}

func TestMachineRoundtrip(t *testing.T) {
	s := open(t)
	if err := s.SaveMachine(localMachine()); err != nil {
		t.Fatal(err)
	}
	got, err := s.Machine("local")
	if err != nil || got.Host != "localhost" || got.User != "tester" {
		t.Fatalf("machine = %+v err=%v", got, err)
	}
	if err := s.TouchMachine("local", "connected"); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Machine("local")
	if got.State != "connected" || got.LastSeen.IsZero() {
		t.Fatalf("touch failed: %+v", got)
	}
}

func TestProjectSessionMessages(t *testing.T) {
	s := open(t)
	if err := s.SaveMachine(localMachine()); err != nil {
		t.Fatal(err)
	}
	p, err := s.CreateProject(protocol.Project{Name: "kiwi_test", Machine: "local", Workdir: "/tmp/kiwi_test"})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.NewSession(p.ID, "html 작업")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendMessage(sess.ID, Message{Role: "user", Content: "랜딩 페이지 만들어"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendMessage(sess.ID, Message{Role: "assistant", ToolCalls: []ToolCallSt{{ID: "1", Name: "write_file", Args: `{"path":"index.html"}`}}}); err != nil {
		t.Fatal(err)
	}
	msgs, err := s.Messages(sess.ID)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("messages = %v err=%v", msgs, err)
	}
	if msgs[1].ToolCalls[0].Name != "write_file" {
		t.Fatalf("tool calls lost: %+v", msgs[1])
	}
	list, err := s.Sessions(p.ID)
	if err != nil || len(list) != 1 || list[0].Name != "html 작업" {
		t.Fatalf("sessions = %v err=%v", list, err)
	}
	if err := s.AddUsage(sess.ID, 100, 50); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Session(sess.ID)
	if got.PromptTokens != 100 || got.CompletionTokens != 50 {
		t.Fatalf("usage = %+v", got)
	}
}

func TestQueue(t *testing.T) {
	s := open(t)
	s.SaveMachine(localMachine())
	p, _ := s.CreateProject(protocol.Project{Name: "q", Machine: "local", Workdir: "/tmp"})
	sess, _ := s.NewSession(p.ID, "")
	s.Enqueue(sess.ID, "first")
	s.Enqueue(sess.ID, "second")
	got, ok, _ := s.Dequeue(sess.ID)
	if !ok || got != "first" {
		t.Fatalf("dequeue = %q ok=%v", got, ok)
	}
	got, ok, _ = s.Dequeue(sess.ID)
	if !ok || got != "second" {
		t.Fatalf("dequeue2 = %q ok=%v", got, ok)
	}
	_, ok, _ = s.Dequeue(sess.ID)
	if ok {
		t.Fatal("queue should be empty")
	}
}

func TestSeededRole(t *testing.T) {
	s := open(t)
	r, err := s.Role("agent-chat")
	if err != nil || r.Provider != "local" || r.Model == "" {
		t.Fatalf("seeded role = %+v err=%v", r, err)
	}
}

func TestReplaceMessages(t *testing.T) {
	s := open(t)
	s.SaveMachine(localMachine())
	p, _ := s.CreateProject(protocol.Project{Name: "r", Machine: "local", Workdir: "/tmp"})
	sess, _ := s.NewSession(p.ID, "")
	s.AppendMessage(sess.ID, Message{Role: "user", Content: "one"})
	s.AppendMessage(sess.ID, Message{Role: "assistant", Content: "two"})
	if err := s.ReplaceMessages(sess.ID, []Message{{Role: "user", Content: "요약"}}); err != nil {
		t.Fatal(err)
	}
	msgs, _ := s.Messages(sess.ID)
	if len(msgs) != 1 || msgs[0].Content != "요약" {
		t.Fatalf("replace failed: %+v", msgs)
	}
}
