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
`/resume` to continue one, `/exit` to exit.

## License

[MIT](LICENSE)
