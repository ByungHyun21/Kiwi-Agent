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
bun run src/kiwi-server.ts        # serves the web app + API
cd web && bun run dev             # or the Vite dev server (proxy included)
bun test
```

## Terminal UI

A terminal client is included for keyboard-first work: the `kiwi` binary
launches an OpenTUI-based full-screen UI (the web app remains the primary
client), and the legacy text UI lives in `src/tui/`. Prebuilt terminal
binaries are available via [install.sh](install.sh) — web app not included,
use Docker for that.


## License

This project is MIT.

- [D2 Coding](https://github.com/naver/d2-coding-font) — SIL OFL 1.1, bundled as the UI font
- [SQLite](https://www.sqlite.org/) — public domain, embedded storage engine
- [SearXNG](https://github.com/searxng/searxng) — AGPL 3.0, bundled sidecar for agent web search
