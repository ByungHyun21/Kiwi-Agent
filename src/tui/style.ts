// Minimal lipgloss-style rendering: SGR styles, padding, width, borders,
// block joins.

import { displayWidth, padRight, truncateAnsi } from "./ansi.ts";

export interface BorderChars {
  top: string;
  bottom: string;
  left: string;
  right: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

export const normalBorder: BorderChars = {
  top: "─", bottom: "─", left: "│", right: "│",
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
};

export const roundedBorder: BorderChars = {
  top: "─", bottom: "─", left: "│", right: "│",
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
};

export interface BorderSide {
  sides: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  color?: string;
  chars: BorderChars;
}

/** Style mirrors the small subset of lipgloss the TUI uses. */
export class Style {
  private fg?: string;
  private bg?: string;
  private boldFlag = false;
  private widthVal = 0;
  private maxHeightVal = 0;
  private padTop = 0;
  private padBottom = 0;
  private padLeft = 0;
  private padRightVal = 0;
  private borderVal?: BorderSide;

  foreground(c: string): Style {
    const s = this.clone();
    s.fg = c;
    return s;
  }

  background(c: string): Style {
    const s = this.clone();
    s.bg = c;
    return s;
  }

  bold(b: boolean): Style {
    const s = this.clone();
    s.boldFlag = b;
    return s;
  }

  width(n: number): Style {
    const s = this.clone();
    s.widthVal = n;
    return s;
  }

  maxHeight(n: number): Style {
    const s = this.clone();
    s.maxHeightVal = n;
    return s;
  }

  /** padding mirrors lipgloss.NewStyle().Padding(v, h). */
  padding(v: number, h: number): Style {
    const s = this.clone();
    s.padTop = v;
    s.padBottom = v;
    s.padLeft = h;
    s.padRightVal = h;
    return s;
  }

  paddingLeft(n: number): Style {
    const s = this.clone();
    s.padLeft = n;
    return s;
  }

  /** border mirrors lipgloss.Border with per-side toggles. */
  border(
    chars: BorderChars,
    top: boolean,
    right: boolean,
    bottom: boolean,
    left: boolean,
    color?: string,
  ): Style {
    const s = this.clone();
    s.borderVal = { sides: { top, right, bottom, left }, color, chars };
    return s;
  }

  private clone(): Style {
    return Object.assign(new Style(), this);
  }

  private sgr(): string {
    const codes: string[] = [];
    if (this.boldFlag) codes.push("1");
    if (this.fg) codes.push(hexToFg(this.fg));
    if (this.bg) codes.push(hexToBg(this.bg));
    if (codes.length === 0) return "";
    return "\x1b[" + codes.join(";") + "m";
  }

  render(text: string): string {
    let lines = text.split("\n");
    // horizontal padding
    if (this.padLeft > 0 || this.padRightVal > 0) {
      const l = " ".repeat(this.padLeft);
      const r = " ".repeat(this.padRightVal);
      lines = lines.map((ln) => l + ln + r);
    }
    // width: pad (and clip) every line
    if (this.widthVal > 0) {
      lines = lines.map((ln) => {
        if (displayWidth(ln) > this.widthVal) return truncateAnsi(ln, this.widthVal, "");
        return padRight(ln, this.widthVal);
      });
    }
    // vertical padding
    for (let i = 0; i < this.padTop; i++) lines.unshift("");
    for (let i = 0; i < this.padBottom; i++) lines.push("");
    // max height
    if (this.maxHeightVal > 0 && lines.length > this.maxHeightVal) {
      lines = lines.slice(0, this.maxHeightVal);
    }
    // border
    if (this.borderVal) {
      lines = applyBorder(lines, this.borderVal, this.innerWidth());
    }
    // SGR per line so block joins keep colors aligned
    const sgr = this.sgr();
    if (sgr) {
      lines = lines.map((ln) => sgr + ln + "\x1b[0m");
    }
    return lines.join("\n");
  }

  private innerWidth(): number {
    let w = this.widthVal;
    if (w <= 0) {
      // derived from the widest rendered line + horizontal padding
      w = 0;
    }
    if (this.borderVal) {
      const b = this.borderVal.sides;
      if (b.left) w += 1;
      if (b.right) w += 1;
    }
    return w;
  }
}

function applyBorder(lines: string[], b: BorderSide, innerW: number): string[] {
  let w = innerW;
  if (w <= 0) {
    for (const ln of lines) w = Math.max(w, displayWidth(ln));
  }
  const colorWrap = (s: string): string => {
    if (!b.color) return s;
    return "\x1b[" + hexToFg(b.color) + "m" + s + "\x1b[0m";
  };
  const out: string[] = [];
  const { top, right, bottom, left } = b.sides;
  if (top) {
    let t = b.chars.topLeft + b.chars.top.repeat(w) + b.chars.topRight;
    out.push(colorWrap(t));
  }
  for (const ln of lines) {
    let row = padRight(ln, w);
    if (left) row = colorWrap(b.chars.left) + row;
    if (right) row += colorWrap(b.chars.right);
    out.push(row);
  }
  if (bottom) {
    let bt = b.chars.bottomLeft + b.chars.bottom.repeat(w) + b.chars.bottomRight;
    out.push(colorWrap(bt));
  }
  return out;
}

/** joinVertical stacks blocks, padding each to the widest line. */
export function joinVertical(_align: string, ...blocks: string[]): string {
  const maxW = Math.max(0, ...blocks.map((b) => widest(b)));
  const out: string[] = [];
  for (const b of blocks) {
    for (const ln of b.split("\n")) {
      out.push(stripTrailingAnsiSafe(ln, maxW));
    }
  }
  return out.join("\n");
}

/** joinHorizontal places blocks side by side, top-aligned. */
export function joinHorizontal(_align: string, ...blocks: string[]): string {
  const cols = blocks.map((b) => {
    const lines = b.split("\n");
    const w = widest(b);
    return { lines: lines.map((ln) => stripTrailingAnsiSafe(ln, w)), w };
  });
  const h = Math.max(0, ...cols.map((c) => c.lines.length));
  const rows: string[] = [];
  for (let i = 0; i < h; i++) {
    rows.push(cols.map((c) => c.lines[i] ?? " ".repeat(c.w)).join(""));
  }
  return rows.join("\n");
}

function widest(b: string): number {
  let w = 0;
  for (const ln of b.split("\n")) w = Math.max(w, displayWidth(ln));
  return w;
}

function stripTrailingAnsiSafe(ln: string, w: number): string {
  if (displayWidth(ln) >= w) return ln;
  return padRight(ln, w);
}

/** width reports the display width of one line of text. */
export function lipWidth(s: string): number {
  return displayWidth(s);
}

/** height counts lines in a block. */
export function lipHeight(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function hexToFg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `38;2;${r};${g};${b}`;
}

export function hexToBg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `48;2;${r};${g};${b}`;
}
