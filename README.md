# Kiwi-Agent

A self-hosted coding agent for your local network.

Kiwi splits the coding agent into two parts: a **server** that runs on one
always-on PC and a **terminal client** that connects to it from anywhere on
your LAN. The agent loop, sessions, and project state live on the server, so
you can sit down at any machine, attach, and pick up where you left off.
The actual work — file edits, shell commands — executes on the machines
where your code lives, relayed by the server over SSH.

```
 your desk PC            server PC                  work machines
┌────────────┐        ┌──────────────────┐        ┌─────────────────┐
│ kiwi (TUI) │◀──────▶│ kiwi-server      │◀─SSH──▶│ repositories     │
│  /project  │  WS    │ · agent loop     │        │ files & shells   │
│  /new      │        │ · projects       │        │ runs kiwi exec   │
│  sessions  │        │ · model routing  │        └─────────────────┘
└────────────┘        │ · document index │
                      │ · web UI         │
                      └──────────────────┘
```

## Why this shape

- **Sessions live on the server.** Start a task at one desk, resume it from
  another. If a work machine goes down, you see it from wherever you are.
- **Work runs where the code is.** The server executes tools on registered
  work machines over SSH via a small structured-exec subcommand
  (`kiwi exec`), not by pasting shell snippets together.
- **Bring your own models.** LLM providers — llama.cpp, Ollama, OpenAI,
  Gemini, anything OpenAI-compatible — are wired per role (chat, OCR,
  embeddings, document cleaning) and can be swapped in the web UI.
- **Your datasheets, searchable.** Uploaded PDFs and documents are parsed,
  cleaned, and indexed (full-text + vectors) so the agent can look things
  up while it works.

## Status

Early development. The surface is landing first; internals follow.

| Area | State |
|---|---|
| Web UI (dashboard, machines, settings, docs) | scaffolded |
| TUI client (address screen, main screen) | scaffolded |
| Token auth, WebSocket protocol | planned |
| SSH execution layer (`kiwi exec`) | planned |
| Agent loop, sessions, projects | planned |
| Document ingestion & search | planned (being designed against real use) |

## Install

### Agent (`kiwi`)

```sh
curl -fsSL https://raw.githubusercontent.com/ByungHyun21/Kiwi-Agent/main/install.sh | sh
```

### Server (`kiwi-server`)

```sh
curl -fsSL https://raw.githubusercontent.com/ByungHyun21/Kiwi-Agent/main/install.sh | sh -s -- kiwi-server
```

The script downloads the latest release binary for your platform into
`~/.local/bin` and falls back to building with Go when no prebuilt binary
exists. Manual alternative:

```sh
go install github.com/ByungHyun21/Kiwi-Agent/cmd/kiwi@latest
go install github.com/ByungHyun21/Kiwi-Agent/cmd/kiwi-server@latest
```

Work machines need `sshd` and the `kiwi` binary on `PATH`
(`~/.local/bin/kiwi` by default) — no daemon, nothing else.

## Quickstart

```sh
# PC A — start the server (default port 5494 = "KIWI" on a phone keypad)
kiwi-server

# PC B — connect the agent
kiwi
# → enter the server address, e.g. 192.168.0.10:5494

# any PC — open the web UI
# http://<server-ip>:5494
```

Inside the agent: `/project` to pick a project, `/new` to start a session,
`/resume` to continue one, `/quit` to exit.

## Security model

Kiwi is designed for trusted local networks (LAN or a VPN such as
Tailscale). The web UI and agent API are protected by a single bearer token;
machine access uses the server's own SSH keys. It is not intended for
exposure to the public internet.

## Development

Requires Go 1.27+ and [templ](https://templ.guide) (`go install
github.com/a-h/templ/cmd/templ@latest`).

```sh
templ generate ./internal/web   # regen templated pages
go build ./...                  # build everything
go run ./cmd/kiwi-server        # run the server
```

```
cmd/kiwi-server/    server binary
cmd/kiwi/           agent TUI + kiwi exec subcommand
internal/web/       templ + htmx web UI (embedded assets)
internal/tui/       terminal client
internal/protocol/  shared API types
internal/agentcore/ LLM loop and tools
internal/exec/      SSH connection pool and remote execution
internal/ingest/    document pipeline
```

## License

[MIT](LICENSE)
