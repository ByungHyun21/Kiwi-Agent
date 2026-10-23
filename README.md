# Kiwi-Agent

A self-hosted coding agent for your home network, driven from the browser.

Kiwi splits the coding agent in two: **kiwi-server** runs on one always-on PC —
agent loop, sessions, projects, model routing — and serves a **web app** on the
LAN. Open `http://<server>:6002` from any browser (PC, tablet, phone) and pick
up where you left off. The actual work — file edits, shell commands — executes
on the machines where your code lives, relayed by the server over SSH.

```
 your browser            server PC                  work machines
┌────────────┐        ┌──────────────────┐        ┌─────────────────┐
│ web app    │◀──WS──▶│ kiwi-server      │◀─SSH──▶│ repositories     │
│ (any device│        │ · agent loop     │        │ files & shells   │
│  on LAN)   │        │ · sessions       │        │ runs kiwi exec   │
└────────────┘        │ · model routing  │        └─────────────────┘
                      └──────┬───────────┘
                             ▼
                      searxng (optional, agent web search)
```

## Why this shape

- **Sessions live on the server.** Start a task at one desk, continue it from
  the tablet on the couch. Nothing to install on client devices — a browser
  is enough.
- **Work runs where the code is.** The server executes tools on registered
  work machines over SSH via a small structured-exec subcommand
  (`kiwi exec`), not by pasting shell snippets together.
- **Bring your own models.** llama.cpp, Ollama, OpenAI-compatible — wire
  providers per role (chat, OCR, embeddings) and swap them in the web UI.
- **Web search without API keys.** Point `SEARXNG_URL` at a SearXNG instance
  on your network to give the agent key-free web search.

## Install (local)

Requires [Bun](https://bun.sh) and key-based SSH access to the work machines.

```sh
git clone https://github.com/ByungHyun21/Kiwi-Agent && cd Kiwi-Agent
bun install
cd web && bun install && bun run build && cd ..

# optional: compile kiwi / kiwi-server binaries
bun run build

# start the server (foreground)
bun run src/kiwi-server.ts --addr 0.0.0.0:6002
# open http://<server-ip>:6002
```

- Web app and API listen on `0.0.0.0:6002` (default `:5494` when `--addr`
  is omitted). Set `KIWI_ADDR` for a different default.
- Sessions, projects, settings and SSH host-key pins persist in
  `~/.local/share/kiwi` (SQLite).
- The server has no authentication — intended for a trusted home LAN. Do not
  expose the port to the internet.
- Web search is optional: open 관리 → 검색엔진 and enter a SearXNG JSON API
  base (for example `http://127.0.0.1:8888`). `SEARXNG_URL` remains a fallback
  for headless setups. Need a local instance? Run `option/searxng` with
  `docker compose up -d` (the main server itself stays Docker-free).
- The SPA is served from `web/dist`; run `cd web && bun run dev` for Vite
  development with `/api` and `/ws` proxying.

### Run as a user service

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/kiwi-server.service <<EOF
[Unit]
Description=Kiwi Agent server

[Service]
WorkingDirectory=$HOME/Kiwi-Agent
Environment=KIWI_WEB_DIST=$HOME/Kiwi-Agent/web/dist
ExecStart=$(command -v bun) run src/kiwi-server.ts --addr 0.0.0.0:6002
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now kiwi-server
```

## Code layout

- `src/shared/protocol.ts` — wire protocol and entity types; the SPA imports it directly
- `src/server/` — HTTP/WS surface (`server.ts`, `ws.ts`, `session.ts`), agent loop and tools (`agent/`), SQLite store, SSH runner
- `src/exec/` — the `kiwi` binary: `kiwi exec` subcommands, LSP broker, self-updater
- `web/` — Vite + React SPA (the only client)
- `option/searxng/` — optional SearXNG compose file for local web search

## Work machines (`kiwi exec`)

Tools run on your work machines over SSH, so each one needs the `kiwi`
binary. Install it with the one-liner (linux/darwin, amd64/arm64 — downloads
the release, or builds from source with [Bun](https://bun.sh) as a fallback):

```sh
curl -fsSL https://raw.githubusercontent.com/ByungHyun21/Kiwi-Agent/main/install.sh | sh
```

This installs to `~/.local/bin/kiwi` — the path the server invokes over SSH,
so it works even when non-interactive SSH shells have a minimal `PATH`.
Installed elsewhere? Set the exec path when registering the machine.

Then:

1. Enable key-based SSH from the server to the machine (the server connects
   with `BatchMode=yes` and cannot answer password prompts).
2. Register the machine in the web app's admin panel (관리 → 기기) or with
   `POST /api/machines`; create a project with `POST /api/projects`.
3. The server pins the machine's SSH host key on first connection (ed25519
   preferred) in `~/.local/share/kiwi/known_hosts.d/` and stores the SHA256
   fingerprint. Later key changes are rejected. The admin panel shows the
   fingerprint and can verify or force a re-pin
   (`POST /api/machines/<name>/pin`, `{"force":true}`).

### Updating

On the machine itself:

```sh
kiwi update
```

Or let the server push it — it runs `kiwi exec update` there over SSH, which
downloads the latest release and replaces the binary in place:

```sh
curl -X POST http://<server-ip>:6002/api/machines/<name>/update
# {"ok":true,"data":"{\"status\":\"updated\",\"version\":\"0.1.1\"}"}
```

`status` is `updated` or `current` (already newest); failures come back as
`{"ok":false,"code":…,"message":…}`. A machine whose kiwi predates this
subcommand answers `unknown command: update` — run `kiwi update` on it once
over SSH.

## License

This project is MIT.

- [D2 Coding](https://github.com/naver/d2-coding-font) — SIL OFL 1.1, bundled as the UI font
- [SQLite](https://www.sqlite.org/) — public domain, embedded storage engine
- [SearXNG](https://github.com/searxng/searxng) — AGPL 3.0, optional external web search backend
