package exec

import (
	"testing"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

type fakeDB struct{ hostKeys map[string]string }

func (f *fakeDB) Machine(name string) (protocol.Machine, error) { return protocol.Machine{}, nil }
func (f *fakeDB) SaveHostKey(name, fp string) error {
	if f.hostKeys == nil {
		f.hostKeys = map[string]string{}
	}
	f.hostKeys[name] = fp
	return nil
}
func (f *fakeDB) TouchMachine(name, state string) error { return nil }

func TestQuoteEscapes(t *testing.T) {
	cases := map[string]string{
		"simple":     "'simple'",
		"has space":  "'has space'",
		"it's":       `'it'\''s'`,
		"a'b'c":      `'a'\''b'\''c'`,
		"한글 파일.html": "'한글 파일.html'",
	}
	for in, want := range cases {
		if got := quote(in); got != want {
			t.Fatalf("quote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeResultJSON(t *testing.T) {
	res := decodeResult(`{"ok":true,"data":"hi"}`, "", nil)
	if !res.OK || res.Data != "hi" {
		t.Fatalf("json decode failed: %+v", res)
	}
}

func TestDecodeResultNotFound(t *testing.T) {
	res := decodeResult("", "/bin/sh: 1: /home/u/.local/bin/kiwi: not found", errFail{})
	if res.OK || res.Code != "not-installed" {
		t.Fatalf("expected not-installed, got %+v", res)
	}
}

func TestDecodeResultGarbage(t *testing.T) {
	res := decodeResult("plain output", "some stderr", nil)
	if res.OK || res.Code != "error" {
		t.Fatalf("expected error, got %+v", res)
	}
}

type errFail struct{}

func (errFail) Error() string { return "exit status 127" }

func TestExpandHome(t *testing.T) {
	m := protocol.Machine{User: "kiwi"}
	if got := expandHome("~/.local/bin/kiwi", m); got != "/home/kiwi/.local/bin/kiwi" {
		t.Fatalf("expandHome = %q", got)
	}
	if got := expandHome("/usr/bin/kiwi", m); got != "/usr/bin/kiwi" {
		t.Fatalf("expandHome absolute = %q", got)
	}
}
