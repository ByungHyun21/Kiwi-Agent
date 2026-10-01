// Minimal terminal markdown renderer (port of the glamour usage). Returns
// display lines; null signals the caller should fall back to plain text.

import { displayWidth } from "./ansi.ts";
import { hexToFg } from "./style.ts";

const C = {
  green: "#8fce5a",
  olive: "#a8c17a",
  dim: "#7d8377",
  text: "#b9b39f",
  white: "#e8eadf",
};

const fg = (hex: string): string => "\x1b[" + hexToFg(hex) + "m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

/** renderMarkdown renders one message to terminal display lines. */
export function renderMarkdown(width: number, text: string): string[] | null {
  try {
    return render(width, text);
  } catch {
    return null;
  }
}

function render(width: number, text: string): string[] {
  const lines = text.replace(/\t/g, "  ").split("\n");
  const out: string[] = [];
  let inCode = false;
  let para: string[] = [];
  let tableRows: string[][] | null = null;

  const flushPara = (): void => {
    if (para.length === 0) return;
    for (const ln of wrap(inlines(para.join(" ")), width)) out.push(ln);
    para = [];
  };

  const flushTable = (): void => {
    if (!tableRows) return;
    out.push(...renderTable(tableRows, width));
    tableRows = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (line.trimStart().startsWith("```")) {
      flushPara();
      flushTable();
      if (!inCode) {
        inCode = true;
        out.push(fg(C.dim) + "  ┌" + "─".repeat(Math.max(4, width - 5)) + reset);
      } else {
        inCode = false;
        out.push(fg(C.dim) + "  └" + "─".repeat(Math.max(4, width - 5)) + reset);
      }
      continue;
    }
    if (inCode) {
      out.push("  " + fg(C.text) + line + reset);
      continue;
    }

    // table
    if (line.trimStart().startsWith("|") && line.includes("|", 1)) {
      flushPara();
      const cells = splitRow(line);
      if (cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue; // separator row
      tableRows ??= [];
      tableRows.push(cells);
      continue;
    }
    flushTable();

    // blank line ends paragraphs
    if (line.trim() === "") {
      flushPara();
      continue;
    }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1]!.length;
      const content = inlines(h[2]!);
      out.push(bold + fg(level <= 2 ? C.green : C.olive) + content + reset);
      if (level <= 2) out.push(fg(C.dim) + "─".repeat(Math.min(displayWidth(content), Math.max(4, width - 1))) + reset);
      continue;
    }

    // blockquote
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      for (const ln of wrap(inlines(q[1]!), Math.max(8, width - 2))) {
        out.push(fg(C.dim) + "│ " + reset + ln);
      }
      continue;
    }

    // list item
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1]!.length;
      for (const [k, ln] of wrap(inlines(li[2]!), Math.max(8, width - indent - 2)).entries()) {
        const bullet = k === 0 ? fg(C.olive) + "• " + reset : "  ";
        out.push(" ".repeat(indent) + bullet + ln);
      }
      continue;
    }
    // ordered list
    const ol = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      const indent = ol[1]!.length;
      for (const [k, ln] of wrap(inlines(ol[3]!), Math.max(8, width - indent - 3)).entries()) {
        const marker = k === 0 ? fg(C.olive) + ol[2] + " " + reset : " ".repeat(displayWidth(ol[2]!) + 1);
        out.push(" ".repeat(indent) + marker + ln);
      }
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  flushTable();
  if (inCode) out.push(fg(C.dim) + "  └" + "─".repeat(Math.max(4, width - 5)) + reset);
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function renderTable(rows: string[][], width: number): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (const r of rows) w = Math.max(w, displayWidth(plain(r[c] ?? "")));
    widths.push(Math.min(w, Math.max(4, Math.floor((width - cols * 3) / Math.max(1, cols)))));
  }
  const out: string[] = [];
  rows.forEach((r, i) => {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const styled = inlines(r[c] ?? "");
      const plainW = displayWidth(plain(r[c] ?? ""));
      cells.push(styled + " ".repeat(Math.max(0, widths[c]! - plainW)));
    }
    out.push(fg(C.dim) + "│ " + reset + cells.join(fg(C.dim) + " │ " + reset) + fg(C.dim) + " │" + reset);
    if (i === 0) {
      const rule = widths.map((w) => "─".repeat(w + 2)).join(fg(C.dim) + "┬" + reset);
      out.push(fg(C.dim) + "┌" + reset + rule + fg(C.dim) + "┐" + reset);
    }
  });
  return out;
}

/** inlines converts **bold**, `code`, *italic* and [text](url). */
function inlines(s: string): string {
  let out = "";
  let rest = s;
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    if (m[1] !== undefined) out += bold + m[1] + reset;
    else if (m[2] !== undefined) out += fg(C.olive) + m[2] + reset;
    else if (m[3] !== undefined) out += "\x1b[3m" + m[3] + reset;
    else if (m[4] !== undefined) out += m[4] + fg(C.dim) + " (" + m[5] + ")" + reset;
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** plain strips markdown inline syntax for width measuring. */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/** wrap does greedy display-width wrapping with inline style awareness. */
function wrap(s: string, width: number): string[] {
  if (s === "") return [""];
  const words: string[] = [];
  let cur = "";
  let curW = 0;
  let plainW = 0;
  const flushWord = (): void => {
    if (cur !== "") words.push(cur);
    cur = "";
    curW = 0;
    plainW = 0;
  };
  for (const ch of s) {
    const isPlain = !ch.startsWith("\x1b");
    const w = isPlain ? charW(ch) : 0;
    if (isPlain && ch === " ") {
      words.push(cur);
      flushWord();
      continue;
    }
    cur += ch;
    curW += w;
    plainW += w;
  }
  flushWord();

  const lines: string[] = [];
  let line = "";
  let w = 0;
  for (const word of words) {
    const ww = wordWidth(word);
    if (line !== "" && w + ww > width) {
      lines.push(line);
      line = "";
      w = 0;
    }
    if (line === "") line = word;
    else line += word; // words already carry no separating spaces
    w += ww;
  }
  lines.push(line);
  return lines;
}

function wordWidth(word: string): number {
  let w = 0;
  for (const ch of word) {
    if (ch.startsWith("\x1b")) continue;
    w += charW(ch);
  }
  return w;
}

function charW(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1f64f)
  ) {
    return 2;
  }
  return 1;
}
