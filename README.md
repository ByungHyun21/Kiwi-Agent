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
                      searxng (sidecar, agent web search)
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
- **Web search without API keys.** A bundled SearXNG sidecar gives the agent
  private, key-free web search on your network.

## Run

Docker (recommended):

```sh
git clone https://github.com/ByungHyun21/Kiwi-Agent && cd Kiwi-Agent
docker compose up -d --build
# open http://<server-ip>:6002
```

- Web app and API on `0.0.0.0:6002`; SearXNG on `8888` (host-local).
- Sessions, projects and settings persist in `~/.local/share/kiwi` (SQLite).
- The server is unauthenticated by default (`KIWI_AUTH=off`) — intended for
  a trusted home LAN. Set `KIWI_AUTH=on` in `docker-compose.yml` to require
  the access token (printed once in the server logs).

Source (dev):

```sh
bun install
cd web && bun install && bun run build && cd ..
bun run src/kiwi-server.ts        # serves web/dist + API (default :5494)
bun test

cd web && bun run dev             # or the Vite dev server, proxying /api and /ws
```

`KIWI_ADDR` sets the listen address (default `:5494`). Without a `web/dist`
build the UI answers with a build hint — run the build above or use Vite.

## Code layout

- `src/shared/protocol.ts` — wire protocol and entity types; the SPA imports it directly
- `src/server/` — HTTP/WS surface (`server.ts`, `ws.ts`, `session.ts`), agent loop and tools (`agent/`), SQLite store, SSH runner
- `src/exec/` — the `kiwi` binary: `kiwi exec` subcommands, LSP broker, self-updater
- `web/` — Vite + React SPA (the only client)

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
`{"ok":false,"code":…,"message":…}`. Add
`-H "Authorization: Bearer $TOKEN"` when `KIWI_AUTH=on`. A machine whose kiwi
predates this subcommand answers `unknown command: update` — run
`kiwi update` on it once over SSH.

## License

This project is MIT.

- [D2 Coding](https://github.com/naver/d2-coding-font) — SIL OFL 1.1, bundled as the UI font
- [SQLite](https://www.sqlite.org/) — public domain, embedded storage engine
- [SearXNG](https://github.com/searxng/searxng) — AGPL 3.0, bundled sidecar for agent web search
