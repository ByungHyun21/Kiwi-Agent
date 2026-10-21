// LSP broker daemon: runs a language server next to the code (kiwi exec side)
// and serves line-JSON requests over a unix socket in <root>/.kiwi-lsp/.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface Pos1 {
  line: number;
  character: number;
}

export function toLspPos(line: number, character: number): { line: number; character: number } {
  return { line: line - 1, character: character - 1 };
}

export function fromLspPos(p: { line: number; character: number }): Pos1 {
  return { line: p.line + 1, character: p.character + 1 };
}

export function langForFile(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "typescript";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "c" || ext === "h") return "c";
  if (ext === "cpp" || ext === "cc" || ext === "cxx" || ext === "hpp" || ext === "hh") return "cpp";
  if (ext === "cs") return "csharp";
  if (ext === "java") return "java";
  return ext;
}

const BUILTIN_SERVERS: Record<string, string[]> = {
  typescript: tsServerCmd(),
  javascript: tsServerCmd(),
  typescriptreact: tsServerCmd(),
  python: ["pyright-langserver", "--stdio"],
  go: ["gopls", "serve"],
  rust: ["rust-analyzer"],
  c: ["clangd"],
  cpp: ["clangd"],
  csharp: ["csharp-ls"],
  java: ["jdtls"],
};

function tsServerCmd(): string[] {
  const home = process.env.HOME ?? "/home";
  const cli = path.join(home, ".local", "share", "kiwi", "lsp-runtime", "node_modules", "typescript-language-server", "lib", "cli.mjs");
  if (!fs.existsSync(cli)) return ["typescript-language-server", "--stdio"];
  let nodeBin = Bun.which("node");
  if (!nodeBin) {
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    try {
      const versions = fs.readdirSync(nvmDir).sort();
      for (let i = versions.length - 1; i >= 0; i--) {
        const cand = path.join(nvmDir, versions[i]!, "bin", "node");
        if (fs.existsSync(cand)) {
          nodeBin = cand;
          break;
        }
      }
    } catch {
      // no nvm layout
    }
  }
  if (!nodeBin) {
    for (const cand of ["/usr/local/bin/node", "/usr/bin/node"]) {
      if (fs.existsSync(cand)) {
        nodeBin = cand;
        break;
      }
    }
  }
  return [nodeBin ?? "node", cli, "--stdio"];
}

export function resolveLangServer(lang: string, root: string): string[] | null {
  const cfgPath = path.join(root, ".kiwi", "lsp.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { languages?: Record<string, string[]> };
    const cmd = cfg.languages?.[lang];
    if (Array.isArray(cmd) && cmd.length > 0) return cmd;
  } catch {
    // no config or unreadable
  }
  return BUILTIN_SERVERS[lang] ?? null;
}

export function lspDir(root: string): string {
  return path.join(root, ".kiwi-lsp");
}

export function lspSocket(lang: string, root: string): string {
  return path.join(lspDir(root), lang + ".sock");
}

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([head, body]);
}

export class FrameReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  next(): unknown | null {
    const idx = this.buf.indexOf("\r\n\r\n");
    if (idx < 0) return null;
    const head = this.buf.subarray(0, idx).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(head);
    if (!m) throw new Error("bad LSP frame header: " + head.slice(0, 60));
    const len = parseInt(m[1]!, 10);
    const start = idx + 4;
    if (this.buf.length < start + len) return null;
    const body = this.buf.subarray(start, start + len).toString("utf8");
    this.buf = this.buf.subarray(start + len);
    return JSON.parse(body);
  }
}

interface OpenDoc {
  version: number;
  uri: string;
}

export interface LspDaemonOpts {
  lang: string;
  root: string;
}

export function runLspDaemon(opts: LspDaemonOpts): void {
  const { lang, root } = opts;
  const keepAlive = setInterval(() => {}, 60_000);
  const sockPath = lspSocket(lang, root);
  fs.mkdirSync(lspDir(root), { recursive: true, mode: 0o755 });
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // fresh socket
  }
  const serverArgv = resolveLangServer(lang, root);
  if (!serverArgv) {
    process.stderr.write(`kiwi lsp-serve: no server for language ${lang}\n`);
    process.exit(1);
  }
  const proc = Bun.spawn(serverArgv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  const diag = new Map<string, unknown[]>();
  const opened = new Map<string, OpenDoc>();

  const reader = new FrameReader();
  const dbg = (msg: string): void => {
    try { fs.appendFileSync(path.join(lspDir(root), lang + ".debug.log"), new Date().toISOString() + " " + msg + "\n"); } catch { /* log best effort */ }
  };
  const pump = () => {
    for (;;) {
      let msg;
      try {
        msg = reader.next();
      } catch {
        break;
      }
      if (msg === null) break;
      const m = msg as { id?: number; method?: string; params?: { uri?: string; diagnostics?: unknown[] }; result?: unknown; error?: unknown };
      if (m.id !== undefined && pending.has(m.id)) {
        dbg(`resp id=${m.id} err=${JSON.stringify(m.error)?.slice(0, 120) ?? ""} result=${JSON.stringify(m.result)?.slice(0, 120) ?? ""}`);
        pending.get(m.id)!(m.result);
        pending.delete(m.id);
      } else if (m.method === "textDocument/publishDiagnostics" && m.params?.uri) {
        dbg(`diag uri=${m.params.uri.slice(-40)} count=${m.params.diagnostics?.length ?? 0}`);
        diag.set(m.params.uri, m.params.diagnostics ?? []);
      } else if (m.method) {
        dbg(`notif ${m.method}`);
      }
    }
  };
  const readLoop = async () => {
    const r = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) {
        clearInterval(keepAlive);
        process.exit(1);
      }
      reader.push(Buffer.from(value));
      pump();
    }
  };
  const send = (msg: unknown): void => {
    proc.stdin.write(encodeFrame(msg));
    proc.stdin.flush();
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };

  const uriOf = (file: string) => pathToFileURL(path.resolve(file)).href;
  const ensureOpen = (file: string): void => {
    const abs = path.resolve(file);
    const uri = uriOf(abs);
    const text = fs.readFileSync(abs, "utf8");
    const cur = opened.get(abs);
    if (!cur) {
      opened.set(abs, { version: 1, uri });
      dbg(`didOpen ${abs} len=${text.length}`);
      notify("textDocument/didOpen", { textDocument: { uri, languageId: lang, version: 1, text } });
    } else {
      cur.version += 1;
      dbg(`didChange ${abs} v${cur.version}`);
      notify("textDocument/didChange", { textDocument: { uri, version: cur.version }, contentChanges: [{ text }] });
      diag.delete(uri);
    }
  };
  const fmtLoc = (loc: { uri: string; range: { start: { line: number; character: number } } }): string => {
    const p = fromLspPos(loc.range.start);
    const rel = path.relative(root, new URL(loc.uri).pathname) || new URL(loc.uri).pathname;
    return `${rel}:${p.line}:${p.character}`;
  };

  const serve = async () => {
    await request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {
        textDocumentSync: 1,
        textDocument: { publishDiagnostics: { relatedInformation: false } },
      },
    });
    notify("initialized", {});
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "") continue;
          void handle(JSON.parse(line)).then((out) => {
            conn.write(JSON.stringify(out) + "\n");
          }).catch((err) => {
            conn.write(JSON.stringify({ ok: false, error: String(err) }) + "\n");
          });
        }
      });
    });
    server.listen(sockPath);
    process.on("exit", () => {
      try { fs.unlinkSync(sockPath); } catch { /* gone */ }
      try { proc.kill(); } catch { /* gone */ }
    });
  };

  const handle = async (req: { id?: number; kind?: string; file?: string; line?: number; char?: number }): Promise<unknown> => {
    switch (req.kind) {
      case "status":
        return { ok: true, running: true, lang, root, serverPid: proc.pid, openFiles: opened.size, server: serverArgv };
      case "diag": {
        const file = req.file!;
        ensureOpen(file);
        const uri = uriOf(file);
        let last: unknown[] | null = null;
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const cur = diag.get(uri);
          if (cur) {
            if (last === cur) break;
            last = cur;
          }
        }
        const items = (last ?? []).map((d) => {
          const dd = d as { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number };
          const p = fromLspPos(dd.range.start);
          return { line: p.line, character: p.character, severity: dd.severity ?? 0, message: dd.message, source: dd.source ?? "", code: dd.code ?? "" };
        });
        return { ok: true, file: path.relative(root, path.resolve(file)), items };
      }
      case "def": {
        const file = req.file!;
        ensureOpen(file);
        const res = (await request("textDocument/definition", {
          textDocument: { uri: uriOf(file) },
          position: toLspPos(req.line ?? 1, req.char ?? 1),
        })) as unknown;
        const locs = flattenLocations(res);
        return { ok: true, locations: locs.map(fmtLoc) };
      }
      case "refs": {
        const file = req.file!;
        ensureOpen(file);
        const res = (await request("textDocument/references", {
          textDocument: { uri: uriOf(file) },
          position: toLspPos(req.line ?? 1, req.char ?? 1),
          context: { includeDeclaration: true },
        })) as unknown;
        const locs = flattenLocations(res);
        return { ok: true, locations: locs.map(fmtLoc) };
      }
      case "symbols": {
        const file = req.file!;
        ensureOpen(file);
        const res = (await request("textDocument/documentSymbol", { textDocument: { uri: uriOf(file) } })) as unknown;
        const flat: { name: string; kind: number; line: number }[] = [];
        const walk = (nodes: unknown[]) => {
          for (const n of nodes) {
            const s = n as { name: string; kind: number; range?: { start: { line: number } }; location?: { range: { start: { line: number } } }; children?: unknown[] };
            const line = (s.range?.start.line ?? s.location?.range.start.line ?? 0) + 1;
            flat.push({ name: s.name, kind: s.kind, line });
            if (s.children) walk(s.children);
          }
        };
        if (Array.isArray(res)) walk(res);
        return { ok: true, symbols: flat };
      }
      case "stop": {
        notify("shutdown", null);
        notify("exit", null);
        clearInterval(keepAlive);
        setTimeout(() => process.exit(0), 150);
        return { ok: true, stopped: true };
      }
      default:
        return { ok: false, error: "unknown kind: " + (req.kind ?? "") };
    }
  };

  void readLoop();
  void serve().catch((err) => {
    process.stderr.write("kiwi lsp-serve: " + String(err) + "\n");
    process.exit(1);
  });
}

function flattenLocations(res: unknown): { uri: string; range: { start: { line: number; character: number } } }[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.filter((x) => (x as { uri?: string }).uri !== undefined) as { uri: string; range: { start: { line: number; character: number } } }[];
}

export function lspCall(lang: string, root: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(lspSocket(lang, root), () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("lsp daemon timeout"));
    }, timeoutMs);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
        sock.destroy();
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function ensureLspDaemon(lang: string, root: string): Promise<Record<string, unknown>> {
  try {
    return await lspCall(lang, root, { kind: "status" }, 3000);
  } catch {
    // start below
  }
  const serverArgv = resolveLangServer(lang, root);
  if (!serverArgv) throw new Error(`지원하지 않는 언어이거나 서버를 찾을 수 없습니다: ${lang}`);
  fs.mkdirSync(lspDir(root), { recursive: true, mode: 0o755 });
  const logFd = fs.openSync(path.join(lspDir(root), lang + ".daemon.log"), "a");
  const entry = path.join(path.dirname(import.meta.path), "kiwi.ts");
  const self = [process.execPath, entry, "exec", "lsp-serve", "--lang", lang, "--root", root];
  Bun.spawn(["setsid", ...self], { stdin: "ignore", stdout: logFd, stderr: logFd });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await lspCall(lang, root, { kind: "status" }, 3000);
    } catch {
      // not up yet
    }
  }
  throw new Error(`lsp 데몬 기동 실패: ${lang} (서버 명령: ${serverArgv.join(" ")})`);
}
