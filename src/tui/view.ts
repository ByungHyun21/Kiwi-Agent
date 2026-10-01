// View: renders the main screen (port of view.go).

import { displayWidth, padRight } from "./ansi.ts";
import { joinHorizontal, joinVertical, Style } from "./style.ts";
import { colorLine, titleStyle, hintStyle, badgeOn, badgeOff } from "./styles.ts";
import { renderTranscript } from "./transcript.ts";
import { rightPanel } from "./panel.ts";
import { popupView } from "./popup.ts";
import { spinnerFrames } from "./model.ts";
import type { Model } from "./model.ts";
import { layoutOf } from "./update.ts";

const normalBorderChars = {
  top: "─",
  bottom: "─",
  left: "│",
  right: "│",
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
};

/** view renders the whole screen. */
export function view(m: Model): string {
  const l = layoutOf(m);

  const header = joinHorizontal("left", titleStyle.render("KIWI"), "  ", statusBadge(m));

  // conversation or fullscreen menu, right of the vertical rule;
  // force the full column width even when the transcript is empty
  let left: string;
  if (m.menu !== null) left = m.menu.render(l.leftW, l.bodyH);
  else left = renderTranscript(m, l.leftW, l.bodyH);
  left = new Style().width(l.leftW).maxHeight(l.bodyH).render(left);

  let leftCol = joinVertical("left", header, "", left);
  leftCol = new Style()
    .border(normalBorderChars, false, false, false, true, colorLine)
    .render(leftCol);

  const right = rightPanel(m, l.bodyH + 2, l.panelW);
  const body = joinHorizontal("top", leftCol, right);

  const divider = new Style().foreground(colorLine).render("─".repeat(Math.max(10, l.width - 2)));

  const t = m.t();
  const helpLeft = hintStyle.render(t.HelpLeft);
  const helpRight = hintStyle.render(t.HelpRight);
  const help = padRight(helpLeft, Math.max(10, l.width - 2) - displayWidth(helpRight)) + helpRight;

  const cols = [body, divider, m.msgIn.view()];
  const sp = spinnerLine(m);
  if (sp !== "") cols.push(sp);
  if (l.popupLines > 0) cols.push(popupView(m, l.width));
  cols.push(m.notice, help);

  return joinVertical("left", ...cols);
}

function statusBadge(m: Model): string {
  if (m.connected) return badgeOn.render(m.t().Connected);
  return badgeOff.render(m.t().Disconnected);
}

/** spinnerLine is the busy indicator shown above the input. */
function spinnerLine(m: Model): string {
  if (!m.busy) return "";
  let label = " 진행 중…";
  if (m.curTool !== "") label = " 진행 중… ⚒ " + m.curTool;
  return new Style()
    .foreground("#a8c17a")
    .bold(true)
    .render(spinnerFrames[m.spinner]! + label);
}
