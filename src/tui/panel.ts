// Sidebar panel rendering (port of panel.go).

import { padRight } from "./ansi.ts";
import { truncate } from "./helpers.ts";
import { joinVertical, Style } from "./style.ts";
import { colorLine, labelStyle, mutedStyle } from "./styles.ts";
import { maxSessions } from "./styles.ts";
import type { Model } from "./model.ts";

/** rightPanel renders the sidebar content without a box: it sits right of a
 *  vertical rule that spans from the top of the window to the input divider. */
export function rightPanel(m: Model, height: number, width: number): string {
  const t = m.t();
  const statusW =
    Math.max(
      Math.max(width0(t.ModelLabel), width0(t.MachineLabel)),
      Math.max(width0(t.ContextLabel), width0(t.GoalLabel)),
    ) + 2;

  const sections: string[] = [
    "", "", // keep clear of the header row
    labelStyle.render(t.ProjectLabel),
    projectLine(m, width - 2),
    "",
    labelStyle.render(t.SessionLabel),
    sessionLines(m, width - 4),
    "",
    new Style().foreground(colorLine).render("─".repeat(Math.max(4, width - 4))),
    "",
    statusRow(m, t.ModelLabel, m.model, statusW, width),
    statusRow(m, t.MachineLabel, m.machine, statusW, width),
    statusRow(m, t.ContextLabel, contextGauge(m), statusW, width),
    statusRow(m, t.GoalLabel, m.goal, statusW, width),
    "",
    labelStyle.render(t.TodoLabel),
    todoLines(m, width - 4),
  ];
  let content = joinVertical("left", ...sections);
  const h = content.split("\n").length;
  if (height > h) content += "\n".repeat(height - h);
  return new Style().width(width).paddingLeft(1).maxHeight(height).render(content);
}

function width0(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x1100 && ch.codePointAt(0)! < 0xff60 ? 2 : 1;
  return w;
}

function projectLine(m: Model, width: number): string {
  if (m.project === "") return mutedStyle.render(m.t().None);
  return truncate(m.project, width);
}

function sessionLines(m: Model, width: number): string {
  if (m.sessions.length === 0) return mutedStyle.render(m.t().NoSessions);
  let b = "";
  for (let i = 0; i < Math.min(m.sessions.length, maxSessions); i++) {
    b += "· " + truncate(m.sessions[i]!, width) + "\n";
  }
  return b.replace(/\n$/, "");
}

/** statusRow renders one "label value" line in the sidebar status block. */
function statusRow(m: Model, label: string, value: string, labelW: number, panelW: number): string {
  let v = value;
  if (v === "") v = mutedStyle.render(m.t().None);
  v = truncate(v, Math.max(4, panelW - labelW - 2));
  return padRight(labelStyle.render(label), labelW) + v;
}

/** contextGauge renders an 8-cell usage bar with a percentage. */
function contextGauge(m: Model): string {
  let pct = 0;
  if (m.ctxMax > 0) pct = Math.min(100, Math.floor((m.ctxUsed * 100) / m.ctxMax));
  const cells = 8;
  const filled = Math.floor((pct * cells) / 100);
  const bar = "█".repeat(filled) + "░".repeat(cells - filled);
  const gauge = `${bar} ${String(pct).padStart(3)}%`;
  if (m.ctxMax === 0) return mutedStyle.render(gauge);
  return gauge;
}

function todoLines(m: Model, width: number): string {
  if (m.todos.length === 0) return mutedStyle.render(m.t().None);
  let b = "";
  for (let i = 0; i < Math.min(m.todos.length, maxSessions); i++) {
    b += "· " + truncate(m.todos[i]!, width) + "\n";
  }
  return b.replace(/\n$/, "");
}
