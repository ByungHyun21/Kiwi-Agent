package execcli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

func run(t *testing.T, argv []string, stdin string) protocol.ExecResult {
	t.Helper()
	var out bytes.Buffer
	code := Run(argv, strings.NewReader(stdin), &out)
	var res protocol.ExecResult
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("invalid JSON output: %v (%q)", err, out.String())
	}
	if (code == 0) != res.OK {
		t.Fatalf("exit code %d vs ok=%v", code, res.OK)
	}
	return res
}

func TestWriteReadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "index.html")
	body := "<!DOCTYPE html>\n<html><body>키위</body></html>\n"

	res := run(t, []string{"write", path}, body)
	if !res.OK {
		t.Fatalf("write failed: %+v", res)
	}

	res = run(t, []string{"read", path}, "")
	if !res.OK || res.Data != body {
		t.Fatalf("read = %+v", res)
	}
}

func TestWriteShaPrecondition(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")

	res := run(t, []string{"write", path}, "v1\n")
	if !res.OK {
		t.Fatal(res)
	}
	sha1 := res.Data

	res = run(t, []string{"write", "--expect-sha", sha1, path}, "v2\n")
	if !res.OK {
		t.Fatalf("preconditioned write failed: %+v", res)
	}

	res = run(t, []string{"write", "--expect-sha", sha1, path}, "v3\n")
	if res.OK || res.Code != "conflict" {
		t.Fatalf("stale sha accepted: %+v", res)
	}

	res = run(t, []string{"read", path}, "")
	if res.Data != "v2\n" {
		t.Fatalf("content changed after rejected write: %q", res.Data)
	}
}

func TestReadMissing(t *testing.T) {
	res := run(t, []string{"read", filepath.Join(t.TempDir(), "nope.txt")}, "")
	if res.OK || res.Code != "noent" {
		t.Fatalf("expected noent, got %+v", res)
	}
}

func TestLs(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)

	res := run(t, []string{"ls", dir}, "")
	if !res.OK || !strings.Contains(res.Data, "b.txt\n") || !strings.Contains(res.Data, "sub/") {
		t.Fatalf("ls = %q", res.Data)
	}
}

func TestInfo(t *testing.T) {
	res := run(t, []string{"info"}, "")
	if !res.OK || !strings.Contains(res.Data, `"os"`) {
		t.Fatalf("info = %+v", res)
	}
}

func TestUnknownCommand(t *testing.T) {
	res := run(t, []string{"frobnicate"}, "")
	if res.OK || res.Code != "badrequest" {
		t.Fatalf("expected badrequest, got %+v", res)
	}
}
