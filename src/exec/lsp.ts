// LSP subcommand, backed by the exec-side language server broker.

import * as path from "node:path";
import type { ExecResult } from "../shared/protocol.ts";
import { ensureLspDaemon, langForFile, lspCall } from "./lspbroker.ts";
import { fail } from "./util.ts";

export async function cmdLsp(argv: string[]): Promise<ExecResult> {
  const [sub, ...rest] = argv;
  const root = path.resolve(process.cwd());
  const pickLang = (arg?: string): string => {
    if (!arg || arg === "") return "";
    return langForFile(arg) !== "" ? langForFile(arg) : arg;
  };
  const started = async (lang: string): Promise<ExecResult> => {
    try {
      const status = await ensureLspDaemon(lang, root);
      return { ok: true, data: JSON.stringify(status) };
    } catch (err) {
      return fail("error", String(err));
    }
  };
  switch (sub) {
    case "start": {
      const lang = rest[0] ?? "";
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp start <lang>");
      return started(lang);
    }
    case "status": {
      const lang = pickLang(rest[0]);
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp status <lang|file>");
      try {
        const status = await lspCall(lang, root, { kind: "status" }, 3000);
        return { ok: true, data: JSON.stringify(status) };
      } catch {
        return { ok: true, data: JSON.stringify({ running: false, lang, root }) };
      }
    }
    case "stop": {
      const lang = pickLang(rest[0]);
      if (lang === "") return fail("badrequest", "usage: kiwi exec lsp stop <lang|file>");
      try {
        const out = await lspCall(lang, root, { kind: "stop" }, 5000);
        return { ok: true, data: JSON.stringify(out) };
      } catch {
        return { ok: true, data: JSON.stringify({ running: false, lang, root }) };
      }
    }
    case "diagnostics": {
      const file = rest[0];
      if (!file) return fail("badrequest", "usage: kiwi exec lsp diagnostics <file>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "diag", file: path.resolve(file) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "definition": {
      const [file, line, char] = rest;
      if (!file || !line || !char) return fail("badrequest", "usage: kiwi exec lsp definition <file> <line> <char>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "def", file: path.resolve(file), line: Number(line), char: Number(char) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "references": {
      const [file, line, char] = rest;
      if (!file || !line || !char) return fail("badrequest", "usage: kiwi exec lsp references <file> <line> <char>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "refs", file: path.resolve(file), line: Number(line), char: Number(char) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    case "symbols": {
      const file = rest[0];
      if (!file) return fail("badrequest", "usage: kiwi exec lsp symbols <file>");
      const st = await started(langForFile(file));
      if (!st.ok) return st;
      const out = await lspCall(langForFile(file), root, { kind: "symbols", file: path.resolve(file) }, 30000);
      return { ok: true, data: JSON.stringify(out) };
    }
    default:
      return fail("badrequest", "usage: kiwi exec lsp <start|status|stop|diagnostics|definition|references|symbols> …");
  }
}
