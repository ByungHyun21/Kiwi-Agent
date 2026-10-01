// ANSI-aware string helpers: display width, truncation, padding.
// Wide (East Asian) characters count as 2 cells.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function runeWidth(r: number): number {
  if (r === 0) return 0;
  if (r < 0x20 || (r >= 0x7f && r < 0xa0)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (r >= lo && r <= hi) return 2;
  }
  return 1;
}

/** displayWidth renders the cell width of s, ignoring ANSI escapes. */
export function displayWidth(s: string): number {
  let w = 0;
  const clean = stripAnsi(s);
  for (const ch of clean) {
    w += runeWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/** truncateAnsi cuts s to w cells, preserving ANSI sequences, appending tail. */
export function truncateAnsi(s: string, w: number, tail = "…"): string {
  if (w < 1) return "";
  let out = "";
  let width = 0;
  let i = 0;
  const tailWidth = displayWidth(tail);
  while (i < s.length) {
    const rest = s.slice(i);
    const ansi = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(rest);
    if (ansi) {
      out += ansi[0];
      i += ansi[0].length;
      continue;
    }
    const ch = rest[0]!;
    const cw = runeWidth(ch.codePointAt(0) ?? 0);
    if (width + cw > w - tailWidth) {
      // check whether the remainder actually fits without the tail
      let restWidth = 0;
      for (const c of stripAnsi(rest)) restWidth += runeWidth(c.codePointAt(0) ?? 0);
      if (width + restWidth <= w) {
        out += rest;
        return out;
      }
      out += tail;
      return out;
    }
    out += ch;
    width += cw;
    i += ch.length;
  }
  return out;
}

/** padRight pads s with spaces to w display cells (ANSI-aware). */
export function padRight(s: string, w: number): string {
  const gap = w - displayWidth(s);
  if (gap <= 0) return s;
  return s + " ".repeat(gap);
}
