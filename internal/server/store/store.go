// Package store persists kiwi-server state in SQLite: settings, machines,
// projects, providers/roles, sessions with messages, and the prompt queue.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

// Open creates or opens the database at path, applying migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // sqlite writes are serialized
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}
	var v int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(version),0) FROM schema_version`).Scan(&v); err != nil {
		return err
	}
	migrations := []string{
		`CREATE TABLE settings (
			key TEXT PRIMARY KEY, value TEXT NOT NULL
		);
		CREATE TABLE machines (
			name TEXT PRIMARY KEY,
			host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
			user TEXT NOT NULL, exec_path TEXT NOT NULL DEFAULT '',
			host_key TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL DEFAULT 'unknown',
			last_seen INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE projects (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			machine TEXT NOT NULL REFERENCES machines(name) ON DELETE CASCADE,
			workdir TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE providers (
			name TEXT PRIMARY KEY,
			base_url TEXT NOT NULL,
			api_key TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE roles (
			role TEXT PRIMARY KEY,
			provider TEXT NOT NULL REFERENCES providers(name),
			model TEXT NOT NULL
		);
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL DEFAULT '',
			goal TEXT NOT NULL DEFAULT '',
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE messages (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '',
			tool_calls TEXT NOT NULL DEFAULT '',
			tool_call_id TEXT NOT NULL DEFAULT '',
			tool_name TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (session_id, seq)
		);
		CREATE TABLE queue (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL
		);`,
	}
	for i := v; i < len(migrations); i++ {
		if _, err := s.db.Exec(migrations[i]); err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := s.db.Exec(`INSERT INTO schema_version(version) VALUES (?)`, i+1); err != nil {
			return err
		}
	}
	return s.seed()
}

func (s *Store) seed() error {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM providers`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := s.db.Exec(`INSERT INTO providers(name, base_url) VALUES ('local','http://localhost:9998/v1')`); err != nil {
			return err
		}
		if _, err := s.db.Exec(`INSERT INTO roles(role, provider, model) VALUES ('agent-chat','local','Qwen3.5-9B')`); err != nil {
			return err
		}
	}
	return nil
}

// ---- settings ----

// Setting returns a settings value, empty when missing.
func (s *Store) Setting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetSetting stores a settings value.
func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings(key,value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// Token returns the auth token, creating one on first use.
func (s *Store) Token() (string, error) {
	if t, err := s.Setting("token"); err != nil || t != "" {
		return t, err
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	t := hex.EncodeToString(raw)
	if err := s.SetSetting("token", t); err != nil {
		return "", err
	}
	return t, nil
}

// ---- machines ----

// Machines lists all registered machines.
func (s *Store) Machines() ([]protocol.Machine, error) {
	rows, err := s.db.Query(`SELECT name, host, port, user, exec_path, host_key, state, last_seen FROM machines ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []protocol.Machine
	for rows.Next() {
		var m protocol.Machine
		var last int64
		if err := rows.Scan(&m.Name, &m.Host, &m.Port, &m.User, &m.ExecPath, &m.HostKey, &m.State, &last); err != nil {
			return nil, err
		}
		m.LastSeen = time.Unix(last, 0)
		out = append(out, m)
	}
	return out, rows.Err()
}

// Machine returns one machine.
func (s *Store) Machine(name string) (protocol.Machine, error) {
	var m protocol.Machine
	var last int64
	err := s.db.QueryRow(`SELECT name, host, port, user, exec_path, host_key, state, last_seen
		FROM machines WHERE name=?`, name).
		Scan(&m.Name, &m.Host, &m.Port, &m.User, &m.ExecPath, &m.HostKey, &m.State, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return m, fmt.Errorf("machine %q not found", name)
	}
	m.LastSeen = time.Unix(last, 0)
	return m, err
}

// SaveMachine inserts or updates a machine.
func (s *Store) SaveMachine(m protocol.Machine) error {
	_, err := s.db.Exec(`INSERT INTO machines(name,host,port,user,exec_path,host_key,state,last_seen)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port,
			user=excluded.user, exec_path=excluded.exec_path, host_key=excluded.host_key,
			state=excluded.state, last_seen=excluded.last_seen`,
		m.Name, m.Host, m.Port, m.User, m.ExecPath, m.HostKey, m.State, m.LastSeen.Unix())
	return err
}

// TouchMachine updates state and last-seen.
func (s *Store) TouchMachine(name, state string) error {
	_, err := s.db.Exec(`UPDATE machines SET state=?, last_seen=? WHERE name=?`,
		state, time.Now().Unix(), name)
	return err
}

// SaveHostKey records the TOFU fingerprint for a machine.
func (s *Store) SaveHostKey(name, fp string) error {
	_, err := s.db.Exec(`UPDATE machines SET host_key=? WHERE name=?`, fp, name)
	return err
}

// DeleteMachine removes a machine.
func (s *Store) DeleteMachine(name string) error {
	_, err := s.db.Exec(`DELETE FROM machines WHERE name=?`, name)
	return err
}

// ---- projects ----

// Projects lists projects.
func (s *Store) Projects() ([]protocol.Project, error) {
	rows, err := s.db.Query(`SELECT id, name, machine, workdir FROM projects ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []protocol.Project
	for rows.Next() {
		var p protocol.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Machine, &p.Workdir); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CreateProject creates a project.
func (s *Store) CreateProject(p protocol.Project) (protocol.Project, error) {
	res, err := s.db.Exec(`INSERT INTO projects(name, machine, workdir, created_at) VALUES(?,?,?,?)`,
		p.Name, p.Machine, p.Workdir, time.Now().Unix())
	if err != nil {
		return p, err
	}
	p.ID, err = res.LastInsertId()
	return p, err
}

// Project returns a project by id.
func (s *Store) Project(id int64) (protocol.Project, error) {
	var p protocol.Project
	err := s.db.QueryRow(`SELECT id, name, machine, workdir FROM projects WHERE id=?`, id).
		Scan(&p.ID, &p.Name, &p.Machine, &p.Workdir)
	return p, err
}

// ProjectByName returns a project by name.
func (s *Store) ProjectByName(name string) (protocol.Project, error) {
	var p protocol.Project
	err := s.db.QueryRow(`SELECT id, name, machine, workdir FROM projects WHERE name=?`, name).
		Scan(&p.ID, &p.Name, &p.Machine, &p.Workdir)
	return p, err
}

// DeleteProject removes a project (registration only, never the folder).
func (s *Store) DeleteProject(id int64) error {
	_, err := s.db.Exec(`DELETE FROM projects WHERE id=?`, id)
	return err
}

// ---- providers & roles ----

// Role describes where a role routes.
type Role struct {
	Role     string `json:"role"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// Provider is an OpenAI-compatible endpoint.
type Provider struct {
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey,omitempty"`
}

// Providers lists configured providers.
func (s *Store) Providers() ([]Provider, error) {
	rows, err := s.db.Query(`SELECT name, base_url, api_key FROM providers ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Provider
	for rows.Next() {
		var p Provider
		if err := rows.Scan(&p.Name, &p.BaseURL, &p.APIKey); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SaveProvider upserts a provider.
func (s *Store) SaveProvider(p Provider) error {
	_, err := s.db.Exec(`INSERT INTO providers(name, base_url, api_key) VALUES(?,?,?)
		ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url, api_key=excluded.api_key`,
		p.Name, p.BaseURL, p.APIKey)
	return err
}

// Role returns the routing for a role.
func (s *Store) Role(role string) (Role, error) {
	var r Role
	err := s.db.QueryRow(`SELECT role, provider, model FROM roles WHERE role=?`, role).
		Scan(&r.Role, &r.Provider, &r.Model)
	return r, err
}

// SetRole routes a role to a provider+model.
func (s *Store) SetRole(r Role) error {
	_, err := s.db.Exec(`INSERT INTO roles(role, provider, model) VALUES(?,?,?)
		ON CONFLICT(role) DO UPDATE SET provider=excluded.provider, model=excluded.model`,
		r.Role, r.Provider, r.Model)
	return err
}

// ---- sessions & messages ----

// Message is one stored conversation entry.
type Message struct {
	Role       string       // system | user | assistant | tool
	Content    string       // text content
	ToolCalls  []ToolCallSt // assistant tool calls
	ToolCallID string       // tool responses
	Name       string       // tool name for tool role
}

// ToolCallSt is a stored tool call.
type ToolCallSt struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Args string `json:"args"`
}

// Session is a stored session row.
type Session struct {
	ID               string
	ProjectID        int64
	Name             string
	Goal             string
	PromptTokens     int64
	CompletionTokens int64
	UpdatedAt        time.Time
}

// NewSession creates a session in a project.
func (s *Store) NewSession(projectID int64, name string) (Session, error) {
	raw := make([]byte, 8)
	rand.Read(raw)
	id := time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(raw)
	if name == "" {
		name = "session " + id
	}
	now := time.Now().Unix()
	sess := Session{ID: id, ProjectID: projectID, Name: name, UpdatedAt: time.Unix(now, 0)}
	_, err := s.db.Exec(`INSERT INTO sessions(id, project_id, name, created_at, updated_at)
		VALUES(?,?,?,?,?)`, id, projectID, name, now, now)
	return sess, err
}

// Sessions lists sessions, newest first, optionally filtered by project.
func (s *Store) Sessions(projectID int64) ([]protocol.SessionInfo, error) {
	q := `SELECT s.id, s.name, p.name, s.updated_at FROM sessions s JOIN projects p ON p.id = s.project_id`
	var args []any
	if projectID > 0 {
		q += ` WHERE s.project_id=?`
		args = append(args, projectID)
	}
	q += ` ORDER BY s.updated_at DESC LIMIT 50`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []protocol.SessionInfo
	for rows.Next() {
		var si protocol.SessionInfo
		var ts int64
		if err := rows.Scan(&si.ID, &si.Name, &si.Project, &ts); err != nil {
			return nil, err
		}
		si.UpdatedAt = time.Unix(ts, 0)
		out = append(out, si)
	}
	return out, rows.Err()
}

// Session loads one session.
func (s *Store) Session(id string) (Session, error) {
	var sess Session
	var ts int64
	err := s.db.QueryRow(`SELECT id, project_id, name, goal, prompt_tokens, completion_tokens, updated_at
		FROM sessions WHERE id=?`, id).
		Scan(&sess.ID, &sess.ProjectID, &sess.Name, &sess.Goal, &sess.PromptTokens, &sess.CompletionTokens, &ts)
	sess.UpdatedAt = time.Unix(ts, 0)
	return sess, err
}

// AppendMessage appends a message with the next sequence number.
func (s *Store) AppendMessage(sessionID string, m Message) error {
	var maxSeq int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(seq),-1) FROM messages WHERE session_id=?`, sessionID).Scan(&maxSeq); err != nil {
		return err
	}
	var calls string
	if len(m.ToolCalls) > 0 {
		b, _ := json.Marshal(m.ToolCalls)
		calls = string(b)
	}
	_, err := s.db.Exec(`INSERT INTO messages(session_id, seq, role, content, tool_calls, tool_call_id, tool_name)
		VALUES(?,?,?,?,?,?,?)`, sessionID, maxSeq+1, m.Role, m.Content, calls, m.ToolCallID, m.Name)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE sessions SET updated_at=? WHERE id=?`, time.Now().Unix(), sessionID)
	return err
}

// Messages loads the conversation history.
func (s *Store) Messages(sessionID string) ([]Message, error) {
	rows, err := s.db.Query(`SELECT role, content, tool_calls, tool_call_id, tool_name
		FROM messages WHERE session_id=? ORDER BY seq`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var calls string
		if err := rows.Scan(&m.Role, &m.Content, &calls, &m.ToolCallID, &m.Name); err != nil {
			return nil, err
		}
		if calls != "" {
			json.Unmarshal([]byte(calls), &m.ToolCalls)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ReplaceMessages swaps the whole history (compact).
func (s *Store) ReplaceMessages(sessionID string, msgs []Message) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, sessionID); err != nil {
		return err
	}
	for i, m := range msgs {
		var calls string
		if len(m.ToolCalls) > 0 {
			b, _ := json.Marshal(m.ToolCalls)
			calls = string(b)
		}
		if _, err := tx.Exec(`INSERT INTO messages(session_id, seq, role, content, tool_calls, tool_call_id, tool_name)
			VALUES(?,?,?,?,?,?,?)`, sessionID, i, m.Role, m.Content, calls, m.ToolCallID, m.Name); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RenameSession sets the session name.
func (s *Store) RenameSession(id, name string) error {
	_, err := s.db.Exec(`UPDATE sessions SET name=? WHERE id=?`, name, id)
	return err
}

// SetGoal stores the session goal.
func (s *Store) SetGoal(id, goal string) error {
	_, err := s.db.Exec(`UPDATE sessions SET goal=? WHERE id=?`, goal, id)
	return err
}

// AddUsage accumulates token usage.
func (s *Store) AddUsage(sessionID string, prompt, completion int64) error {
	_, err := s.db.Exec(`UPDATE sessions SET prompt_tokens=prompt_tokens+?, completion_tokens=completion_tokens+?, updated_at=?
		WHERE id=?`, prompt, completion, time.Now().Unix(), sessionID)
	return err
}

// ---- queue ----

// Enqueue appends a prompt to a session queue.
func (s *Store) Enqueue(sessionID, prompt string) error {
	_, err := s.db.Exec(`INSERT INTO queue(session_id, prompt) VALUES(?,?)`, sessionID, prompt)
	return err
}

// Dequeue pops the oldest queued prompt, empty ok when none.
func (s *Store) Dequeue(sessionID string) (string, bool, error) {
	var seq int64
	var prompt string
	err := s.db.QueryRow(`SELECT seq, prompt FROM queue WHERE session_id=? ORDER BY seq LIMIT 1`, sessionID).Scan(&seq, &prompt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	_, err = s.db.Exec(`DELETE FROM queue WHERE seq=?`, seq)
	return prompt, true, err
}
