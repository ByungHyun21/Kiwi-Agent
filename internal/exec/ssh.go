// Package exec runs kiwi exec tool operations on work machines over SSH.
// The transport is invisible to the agent: callers pass relative argv and
// a workdir; results come back as protocol.ExecResult.
package exec

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

const defaultExecPath = "~/.local/bin/kiwi"

// MachineDB persists machine state for the pool (implemented by store).
type MachineDB interface {
	Machine(name string) (protocol.Machine, error)
	SaveHostKey(name, fp string) error
	TouchMachine(name, state string) error
}

// Runner executes one kiwi exec invocation on a machine.
type Runner interface {
	Run(ctx context.Context, m protocol.Machine, workdir string, argv []string, payload []byte) protocol.ExecResult
}

// SSHRunner runs kiwi exec over a persistent per-machine connection pool.
type SSHRunner struct {
	DB   MachineDB
	Auth []ssh.AuthMethod

	pool map[string]*ssh.Client
}

// NewSSHRunner builds a runner with an empty pool.
func NewSSHRunner(db MachineDB) *SSHRunner {
	return &SSHRunner{DB: db, pool: map[string]*ssh.Client{}}
}

// DefaultAuth uses the ssh-agent, falling back to the default ed25519 key.
func DefaultAuth() []ssh.AuthMethod {
	var methods []ssh.AuthMethod
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
		}
	}
	if key, err := os.ReadFile(os.Getenv("HOME") + "/.ssh/id_ed25519"); err == nil {
		if signer, err := ssh.ParsePrivateKey(key); err == nil {
			methods = append(methods, ssh.PublicKeys(signer))
		}
	}
	return methods
}

// Run executes argv on the machine inside workdir.
func (r *SSHRunner) Run(ctx context.Context, m protocol.Machine, workdir string, argv []string, payload []byte) protocol.ExecResult {
	client, err := r.client(m)
	if err != nil {
		r.failMachine(m, err)
		return protoErr("unreachable", err.Error())
	}

	execPath := m.ExecPath
	if execPath == "" {
		execPath = defaultExecPath
	}
	cmdParts := []string{"cd", quote(workdir), "&&", quote(expandHome(execPath, m)), "exec"}
	for _, a := range argv {
		cmdParts = append(cmdParts, quote(a))
	}
	cmd := strings.Join(cmdParts, " ")

	session, err := client.NewSession()
	if err != nil {
		r.drop(m.Name)
		return protoErr("error", "session: "+err.Error())
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if len(payload) > 0 {
		in, err := session.StdinPipe()
		if err != nil {
			return protoErr("error", err.Error())
		}
		go func() {
			in.Write(payload)
			in.Close()
		}()
	}

	done := make(chan error, 1)
	go func() { done <- session.Run(cmd) }()

	select {
	case err := <-done:
		r.DB.TouchMachine(m.Name, "connected")
		return decodeResult(stdout.String(), stderr.String(), err)
	case <-ctx.Done():
		session.Close()
		return protoErr("timeout", "execution canceled")
	}
}

func decodeResult(stdout, stderr string, runErr error) protocol.ExecResult {
	stdout = strings.TrimSpace(stdout)
	if stdout != "" {
		var res protocol.ExecResult
		if err := json.Unmarshal([]byte(stdout), &res); err == nil {
			return res
		}
	}
	// no structured output: classify
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = strings.TrimSpace(stdout)
	}
	if runErr != nil {
		msg = runErr.Error() + ": " + msg
	}
	if strings.Contains(msg, "not found") {
		return protoErr("not-installed", "kiwi exec not found on machine: "+msg)
	}
	return protoErr("error", msg)
}

func (r *SSHRunner) client(m protocol.Machine) (*ssh.Client, error) {
	if c, ok := r.pool[m.Name]; ok {
		if _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); err == nil {
			return c, nil
		}
		r.drop(m.Name)
	}

	cfg := &ssh.ClientConfig{
		User:            m.User,
		Auth:            r.Auth,
		HostKeyCallback: r.tofu(m),
		Timeout:         10 * time.Second,
	}
	addr := net.JoinHostPort(m.Host, strconv.Itoa(m.Port))
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, err
	}
	r.pool[m.Name] = client
	r.DB.TouchMachine(m.Name, "connected")
	go r.keepalive(m.Name)
	return client, nil
}

func (r *SSHRunner) drop(name string) {
	if c, ok := r.pool[name]; ok {
		c.Close()
		delete(r.pool, name)
	}
}

func (r *SSHRunner) failMachine(m protocol.Machine, err error) {
	r.drop(m.Name)
	_ = r.DB.TouchMachine(m.Name, "disconnected")
}

func (r *SSHRunner) keepalive(name string) {
	for {
		time.Sleep(30 * time.Second)
		c, ok := r.pool[name]
		if !ok {
			return
		}
		if _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); err != nil {
			r.drop(name)
			_ = r.DB.TouchMachine(name, "disconnected")
			return
		}
		_ = r.DB.TouchMachine(name, "connected")
	}
}

// tofu verifies host keys on first use and pins the fingerprint.
func (r *SSHRunner) tofu(m protocol.Machine) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)
		if m.HostKey == "" {
			return r.DB.SaveHostKey(m.Name, fp)
		}
		if m.HostKey != fp {
			return fmt.Errorf("host key mismatch for %s: got %s, pinned %s", m.Name, fp, m.HostKey)
		}
		return nil
	}
}

func expandHome(p string, m protocol.Machine) string {
	if strings.HasPrefix(p, "~/") {
		return "/home/" + m.User + p[1:]
	}
	return p
}

// quote wraps one argument for a POSIX remote shell.
func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func protoErr(code, msg string) protocol.ExecResult {
	return protocol.ExecResult{OK: false, Code: code, Message: msg}
}

// ErrNotInstalled reports the kiwi-missing condition.
var ErrNotInstalled = errors.New("not-installed")
