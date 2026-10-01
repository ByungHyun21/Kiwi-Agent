// Geometry helpers (port of helpers.go).

import { truncateAnsi } from "./ansi.ts";
import { rightPanelWidth } from "./styles.ts";

/** panelWidth returns the right panel width for the terminal width. */
export function panelWidth(w: number): number {
  let pw = rightPanelWidth;
  if (w < 100) pw = Math.floor(w / 3);
  if (pw > w - 20) pw = w - 20;
  if (pw < 12) pw = 12;
  return pw;
}

/** inputWidth returns the text input width for the terminal width. */
export function inputWidth(w: number): number {
  let iw = w - panelWidth(w) - 4;
  if (iw < 10) iw = 10;
  return iw;
}

/** truncate clips s to w display cells with an ellipsis. */
export function truncate(s: string, w: number): string {
  return truncateAnsi(s, w, "…");
}
