// Command popup rendering (port of popup.go).

import { displayWidth, padRight, truncateAnsi } from "./ansi.ts";
import { truncate } from "./helpers.ts";
import { popupMaxRows, popupSelStyle, popupAliasStyle, popupStyle } from "./styles.ts";
import { candidates } from "./commands.ts";
import type { Model } from "./model.ts";

export function clampPopupSel(m: Model, n: number): number {
  if (n <= 0) return 0;
  if (m.popupSel < 0) return 0;
  if (m.popupSel >= n) return n - 1;
  return m.popupSel;
}

/** popupView renders the full-width command popup shown below the input:
 *  name column and description column, both left-aligned, rows padded to
 *  the full width so the selection highlight spans the box. */
export function popupView(m: Model, width: number): string {
  const items = candidates(m);
  if (items.length === 0 || m.popupGone) return "";

  // visible window around the selection
  const sel = clampPopupSel(m, items.length);
  let start = sel - popupMaxRows + 1;
  if (start < 0) start = 0;
  if (start + popupMaxRows > items.length) {
    start = items.length - popupMaxRows;
    if (start < 0) start = 0;
  }
  const visible = items.slice(start, Math.min(start + popupMaxRows, items.length));

  let rowW = width - 4; // box border (2) + left padding
  if (rowW < 20) rowW = 20;
  // popupStyle has PaddingLeft(1) and Width includes padding, so rows
  const contentW = rowW - 1;

  // three columns: command, shortcut, description
  let nameW = 0;
  let aliasW = 0;
  for (const it of items) {
    nameW = Math.max(nameW, displayWidth(it.name));
    aliasW = Math.max(aliasW, displayWidth(it.alias));
  }
  nameW += 2;
  aliasW += 2;

  const rows: string[] = [];
  visible.forEach((it, i) => {
    const idx = start + i;
    let row: string;
    if (idx === sel) {
      // plain row only: nested ANSI resets would drop the background
      row = padRight(it.name, nameW) + padRight(it.alias, aliasW) + it.desc;
      row = popupSelStyle.render(truncateAnsi(padRight(row, contentW), contentW, ""));
    } else {
      const alias = popupAliasStyle.render(padRight(it.alias, aliasW));
      row = padRight(it.name, nameW) + alias + it.desc;
      row = truncateAnsi(padRight(row, contentW), contentW, "");
    }
    rows.push(row);
  });

  return popupStyle
    .width(rowW)
    .maxHeight(popupMaxRows + 2)
    .render(rows.join("\n"));
}

export { truncate };
