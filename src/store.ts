// Persists kiwi-server state in SQLite: settings, machines, projects,
// providers/roles, sessions with messages, and the prompt queue.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Machine, Project, SessionInfo } from "./protocol.ts";

/** Role describes where a role routes. */
export interface Role {
  role: string;
  provider: string;
  model: string;
}

/** Provider is an OpenAI-compatible endpoint. */
export interface Provider {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

/** StoredToolCall is a stored tool call. */
export interface StoredToolCall {
  id: string;
  name: string;
  args: string;
}

/** Message is one stored conversation entry. */
export interface Message {
  role: string; // system | user | assistant | tool
  content: string;
  toolCalls?: StoredToolCall[]; // assistant tool calls
  toolCallID?: string; // tool responses
  name?: string; // tool name for tool role
}

/** Session is a stored session row. */
export interface Session {
  id: string;
  projectId: number;
  name: string;
  goal: string;
  promptTokens: number;
  completionTokens: number;
  updatedAt: Date;
}

export class NotFoundError extends Error {}

/** Store wraps the SQLite database. */
export class Store {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /** Open creates or opens the database at filePath, applying migrations. */
  static open(filePath: string): Store {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
    const db = new Database(filePath, { create: true });
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = 1");
    const s = new Store(db);
    s.migrate();
    return s;
  }

  /** Close closes the database. */
  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.query(`SELECT COALESCE(MAX(version),0) AS v FROM schema_version`).get() as { v: number };
    const v = row?.v ?? 0;
    const migrations: string[] = [
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
    ];
    for (let i = v; i < migrations.length; i++) {
      this.db.run(migrations[i]!);
      this.db.run(`INSERT INTO schema_version(version) VALUES (?)`, [i + 1]);
    }
    this.seed();
  }

  private seed(): void {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM providers`).get() as { n: number };
    if ((row?.n ?? 0) === 0) {
      this.db.run(`INSERT INTO providers(name, base_url) VALUES ('local','http://localhost:9998/v1')`);
      this.db.run(`INSERT INTO roles(role, provider, model) VALUES ('agent-chat','local','Qwen3.5-9B')`);
    }
  }

  // ---- settings ----

  /** Setting returns a settings value, empty when missing. */
  setting(key: string): string {
    const row = this.db.query(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | null;
    return row?.value ?? "";
  }

  /** SetSetting stores a settings value. */
  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings(key,value) VALUES(?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
  }

  /** Token returns the auth token, creating one on first use. */
  token(): string {
    const t = this.setting("token");
    if (t !== "") return t;
    const tok = randomBytes(24).toString("hex");
    this.setSetting("token", tok);
    return tok;
  }

  // ---- machines ----

  private rowToMachine(r: Record<string, unknown>): Machine {
    const last = r.last_seen as number;
    return {
      name: r.name as string,
      host: r.host as string,
      port: r.port as number,
      user: r.user as string,
      execPath: (r.exec_path as string) || undefined,
      hostKey: (r.host_key as string) || undefined,
      state: r.state as string,
      lastSeen: last ? new Date(last * 1000) : undefined,
    };
  }

  /** Machines lists all registered machines. */
  machines(): Machine[] {
    const rows = this.db
      .query(`SELECT name, host, port, user, exec_path, host_key, state, last_seen FROM machines ORDER BY name`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMachine(r));
  }

  /** Machine returns one machine. */
  machine(name: string): Machine {
    const r = this.db
      .query(`SELECT name, host, port, user, exec_path, host_key, state, last_seen FROM machines WHERE name=?`)
      .get(name) as Record<string, unknown> | null;
    if (!r) throw new NotFoundError(`machine "${name}" not found`);
    return this.rowToMachine(r);
  }

  /** SaveMachine inserts or updates a machine. */
  saveMachine(m: Machine): void {
    this.db.run(
      `INSERT INTO machines(name,host,port,user,exec_path,host_key,state,last_seen)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port,
         user=excluded.user, exec_path=excluded.exec_path, host_key=excluded.host_key,
         state=excluded.state, last_seen=excluded.last_seen`, [m.name, m.host, m.port, m.user, m.execPath ?? "", m.hostKey ?? "", m.state || "unknown", Math.floor((m.lastSeen?.getTime() ?? Date.now()) / 1000)]);
  }

  /** TouchMachine updates state and last-seen. */
  touchMachine(name: string, state: string): void {
    this.db.run(`UPDATE machines SET state=?, last_seen=? WHERE name=?`, [state, Math.floor(Date.now() / 1000), name]);
  }

  /** SaveHostKey records the TOFU fingerprint for a machine. */
  saveHostKey(name: string, fp: string): void {
    this.db.run(`UPDATE machines SET host_key=? WHERE name=?`, [fp, name]);
  }

  /** DeleteMachine removes a machine. */
  deleteMachine(name: string): void {
    this.db.run(`DELETE FROM machines WHERE name=?`, [name]);
  }

  // ---- projects ----

  /** Projects lists projects. */
  projects(): Project[] {
    const rows = this.db
      .query(`SELECT id, name, machine, workdir FROM projects ORDER BY name`)
      .all() as { id: number; name: string; machine: string; workdir: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, machine: r.machine, workdir: r.workdir }));
  }

  /** CreateProject creates a project. */
  createProject(p: Project): Project {
    const res = this.db.run(`INSERT INTO projects(name, machine, workdir, created_at) VALUES(?,?,?,?)`, [p.name, p.machine, p.workdir, Math.floor(Date.now() / 1000)]);
    return { ...p, id: Number(res.lastInsertRowid) };
  }

  /** Project returns a project by id. */
  project(id: number): Project {
    const r = this.db
      .query(`SELECT id, name, machine, workdir FROM projects WHERE id=?`)
      .get(id) as { id: number; name: string; machine: string; workdir: string } | null;
    if (!r) throw new NotFoundError(`project ${id} not found`);
    return { id: r.id, name: r.name, machine: r.machine, workdir: r.workdir };
  }

  /** ProjectByName returns a project by name. */
  projectByName(name: string): Project {
    const r = this.db
      .query(`SELECT id, name, machine, workdir FROM projects WHERE name=?`)
      .get(name) as { id: number; name: string; machine: string; workdir: string } | null;
    if (!r) throw new NotFoundError(`project "${name}" not found`);
    return { id: r.id, name: r.name, machine: r.machine, workdir: r.workdir };
  }

  /** DeleteProject removes a project (registration only, never the folder). */
  deleteProject(id: number): void {
    this.db.run(`DELETE FROM projects WHERE id=?`, [id]);
  }

  // ---- providers & roles ----

  /** Providers lists configured providers. */
  providers(): Provider[] {
    const rows = this.db
      .query(`SELECT name, base_url, api_key FROM providers ORDER BY name`)
      .all() as { name: string; base_url: string; api_key: string }[];
    return rows.map((r) => ({
      name: r.name,
      baseUrl: r.base_url,
      apiKey: r.api_key || undefined,
    }));
  }

  /** SaveProvider upserts a provider. */
  saveProvider(p: Provider): void {
    this.db.run(
      `INSERT INTO providers(name, base_url, api_key) VALUES(?,?,?)
       ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url, api_key=excluded.api_key`, [p.name, p.baseUrl, p.apiKey ?? ""]);
  }

  /** Role returns the routing for a role. */
  role(role: string): Role {
    const r = this.db
      .query(`SELECT role, provider, model FROM roles WHERE role=?`)
      .get(role) as { role: string; provider: string; model: string } | null;
    if (!r) throw new NotFoundError(`role ${role} not found`);
    return { role: r.role, provider: r.provider, model: r.model };
  }

  /** SetRole routes a role to a provider+model. */
  setRole(r: Role): void {
    this.db.run(
      `INSERT INTO roles(role, provider, model) VALUES(?,?,?)
       ON CONFLICT(role) DO UPDATE SET provider=excluded.provider, model=excluded.model`, [r.role, r.provider, r.model]);
  }

  // ---- sessions & messages ----

  /** NewSession creates a session in a project. */
  newSession(projectId: number, name: string): Session {
    const id = sessionID();
    if (name === "") name = "session " + id;
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO sessions(id, project_id, name, created_at, updated_at) VALUES(?,?,?,?,?)`, [id, projectId, name, now, now]);
    return { id, projectId, name, goal: "", promptTokens: 0, completionTokens: 0, updatedAt: new Date(now * 1000) };
  }

  /** Sessions lists sessions, newest first, optionally filtered by project. */
  sessions(projectId: number): SessionInfo[] {
    let q = `SELECT s.id, s.name, p.name AS project, s.updated_at FROM sessions s JOIN projects p ON p.id = s.project_id`;
    const params: SQLQueryBindings[] = [];
    if (projectId > 0) {
      q += ` WHERE s.project_id=?`;
      params.push(projectId);
    }
    q += ` ORDER BY s.updated_at DESC LIMIT 50`;
    const rows = this.db.query(q).all(...params) as { id: string; name: string; project: string; updated_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      project: r.project,
      updatedAt: new Date(r.updated_at * 1000),
    }));
  }

  /** Session loads one session. */
  session(id: string): Session {
    const r = this.db
      .query(
        `SELECT id, project_id, name, goal, prompt_tokens, completion_tokens, updated_at
         FROM sessions WHERE id=?`,
      )
      .get(id) as { id: string; project_id: number; name: string; goal: string; prompt_tokens: number; completion_tokens: number; updated_at: number } | null;
    if (!r) throw new NotFoundError(`session "${id}" not found`);
    return {
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      goal: r.goal,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      updatedAt: new Date(r.updated_at * 1000),
    };
  }

  /** AppendMessage appends a message with the next sequence number. */
  appendMessage(sessionID: string, m: Message): void {
    const row = this.db.query(`SELECT COALESCE(MAX(seq),-1) AS maxSeq FROM messages WHERE session_id=?`).get(sessionID) as { maxSeq: number };
    const calls = m.toolCalls && m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : "";
    this.db.run(
      `INSERT INTO messages(session_id, seq, role, content, tool_calls, tool_call_id, tool_name)
       VALUES(?,?,?,?,?,?,?)`, [sessionID, (row?.maxSeq ?? -1) + 1, m.role, m.content, calls, m.toolCallID ?? "", m.name ?? ""]);
    this.db.run(`UPDATE sessions SET updated_at=? WHERE id=?`, [Math.floor(Date.now() / 1000), sessionID]);
  }

  /** Messages loads the conversation history. */
  messages(sessionID: string): Message[] {
    const rows = this.db
      .query(`SELECT role, content, tool_calls, tool_call_id, tool_name FROM messages WHERE session_id=? ORDER BY seq`)
      .all(sessionID) as { role: string; content: string; tool_calls: string; tool_call_id: string; tool_name: string }[];
    return rows.map((r) => {
      const m: Message = { role: r.role, content: r.content, toolCallID: r.tool_call_id, name: r.tool_name };
      if (r.tool_calls !== "") {
        try {
          m.toolCalls = JSON.parse(r.tool_calls) as StoredToolCall[];
        } catch {
          // ignore malformed
        }
      }
      return m;
    });
  }

  /** ReplaceMessages swaps the whole history (compact). */
  replaceMessages(sessionID: string, msgs: Message[]): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM messages WHERE session_id=?`, [sessionID]);
      msgs.forEach((m, i) => {
        const calls = m.toolCalls && m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : "";
        this.db.run(
          `INSERT INTO messages(session_id, seq, role, content, tool_calls, tool_call_id, tool_name)
           VALUES(?,?,?,?,?,?,?)`, [sessionID, i, m.role, m.content, calls, m.toolCallID ?? "", m.name ?? ""]);
      });
    })();
  }

  /** RenameSession sets the session name. */
  renameSession(id: string, name: string): void {
    this.db.run(`UPDATE sessions SET name=? WHERE id=?`, [name, id]);
  }

  /** SetGoal stores the session goal. */
  setGoal(id: string, goal: string): void {
    this.db.run(`UPDATE sessions SET goal=? WHERE id=?`, [goal, id]);
  }

  /** AddUsage accumulates token usage. */
  addUsage(sessionID: string, prompt: number, completion: number): void {
    this.db.run(
      `UPDATE sessions SET prompt_tokens=prompt_tokens+?, completion_tokens=completion_tokens+?, updated_at=? WHERE id=?`, [prompt, completion, Math.floor(Date.now() / 1000), sessionID]);
  }

  // ---- queue ----

  /** Enqueue appends a prompt to a session queue. */
  enqueue(sessionID: string, prompt: string): void {
    this.db.run(`INSERT INTO queue(session_id, prompt) VALUES(?,?)`, [sessionID, prompt]);
  }

  /** Dequeue pops the oldest queued prompt, null when none. */
  dequeue(sessionID: string): string | null {
    const row = this.db
      .query(`SELECT seq, prompt FROM queue WHERE session_id=? ORDER BY seq LIMIT 1`)
      .get(sessionID) as { seq: number; prompt: string } | null;
    if (!row) return null;
    this.db.run(`DELETE FROM queue WHERE seq=?`, [row.seq]);
    return row.prompt;
  }
}

function sessionID(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return stamp + "-" + randomBytes(8).toString("hex");
}
