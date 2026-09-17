// Package execcli implements the kiwi exec subcommands: structured JSON
// file operations executed on work machines over SSH.
package execcli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// Version is reported by the info command.
var Version = "dev"

// Run executes one kiwi exec subcommand. argv excludes the leading "exec".
// Always prints exactly one ExecResult JSON on stdout; returns the exit code.
func Run(argv []string, stdin io.Reader, stdout io.Writer) int {
	var res protocol.ExecResult
	if len(argv) == 0 {
		res = fail("badrequest", "usage: kiwi exec <read|write|ls|info> [args]")
	} else {
		res = dispatch(argv, stdin)
	}
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(res); err != nil {
		fmt.Fprintf(os.Stderr, "kiwi exec: %v\n", err)
		return 2
	}
	if res.OK {
		return 0
	}
	return 1
}

func dispatch(argv []string, stdin io.Reader) protocol.ExecResult {
	cmd, rest := argv[0], argv[1:]
	switch cmd {
	case "read":
		return cmdRead(rest)
	case "write":
		return cmdWrite(rest, stdin)
	case "ls":
		return cmdLs(rest)
	case "info":
		return cmdInfo()
	default:
		return fail("badrequest", "unknown command: "+cmd)
	}
}

func cmdRead(argv []string) protocol.ExecResult {
	path, ok := popPath(argv)
	if !ok {
		return fail("badrequest", "usage: kiwi exec read <path>")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return errResult(err)
	}
	return protocol.ExecResult{OK: true, Data: string(data)}
}

func cmdWrite(argv []string, stdin io.Reader) protocol.ExecResult {
	var path, expectSha string
	args := argv
	for len(args) > 0 {
		switch args[0] {
		case "--expect-sha":
			if len(args) < 2 {
				return fail("badrequest", "--expect-sha requires a value")
			}
			expectSha = args[1]
			args = args[2:]
		default:
			if path != "" {
				return fail("badrequest", "unexpected argument: "+args[0])
			}
			path = args[0]
			args = args[1:]
		}
	}
	if path == "" {
		return fail("badrequest", "usage: kiwi exec write [--expect-sha <sha>] <path>")
	}

	if expectSha != "" {
		current := ""
		if old, err := os.ReadFile(path); err == nil {
			current = shaHex(old)
		}
		if current != expectSha {
			return fail("conflict", fmt.Sprintf("content changed since read (sha %s, expected %s)", shortSha(current), shortSha(expectSha)))
		}
	}

	content, err := io.ReadAll(stdin)
	if err != nil {
		return fail("error", "read stdin: "+err.Error())
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return errResult(err)
		}
	}
	if err := writeFileAtomic(path, content, 0o644); err != nil {
		return errResult(err)
	}
	return protocol.ExecResult{OK: true, Data: shaHex(content)}
}

func cmdLs(argv []string) protocol.ExecResult {
	path := "."
	if len(argv) > 0 {
		path = argv[0]
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return errResult(err)
	}
	var b strings.Builder
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		b.WriteString(name + "\n")
	}
	return protocol.ExecResult{OK: true, Data: b.String()}
}

func cmdInfo() protocol.ExecResult {
	info := map[string]string{
		"version": Version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
	}
	data, _ := json.Marshal(info)
	return protocol.ExecResult{OK: true, Data: string(data)}
}

func popPath(argv []string) (string, bool) {
	if len(argv) == 0 || argv[0] == "" {
		return "", false
	}
	return argv[0], true
}

func shaHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func shortSha(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

func writeFileAtomic(path string, content []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".kiwi-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

func errResult(err error) protocol.ExecResult {
	switch {
	case os.IsNotExist(err):
		return fail("noent", err.Error())
	case os.IsPermission(err):
		return fail("denied", err.Error())
	default:
		return fail("error", err.Error())
	}
}

func fail(code, msg string) protocol.ExecResult {
	return protocol.ExecResult{OK: false, Code: code, Message: msg}
}
