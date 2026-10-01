// Update: message handling for the kiwi TUI (port of update.go).

import type { Event } from "../protocol.ts";
import { applyEvent, scrollBy } from "./transcript.ts";
import { inputWidth, panelWidth } from "./helpers.ts";
import { sanitizeInput } from "./noise.ts";
import { saveServer } from "./config.ts";
import { clampPopupSel, popupView } from "./popup.ts";
import { candidates } from "./commands.ts";
import { menuModels, menuProjects, menuServer, updateMenu } from "./menu.ts";
import { execAction, runCommand } from "./cmdexec.ts";
import {
  fetchMachines,
  fetchRole,
  sendCmd,
  type MachinesMsg,
  type ModelsMsg,
  type ProjectsMsg,
  type RoleMsg,
  type SessionsForProjectMsg,
  type UsageMsg,
} from "./client.ts";
import { spinnerFrames } from "./model.ts";
import { tline, LineKind } from "./transcript.ts";
import type { Model } from "./model.ts";
import type { Cmd } from "./term.ts";
import type { KeyMsg, MouseWheelMsg } from "./term.ts";

/** layout is the single source of view geometry. */
export interface Layout {
  width: number;
  height: number;
  panelW: number; // sidebar width
  leftW: number; // transcript column width
  bodyH: number; // transcript column height
  popupLines: number; // command popup height, 0 when closed
}

/** layoutOf computes the current geometry once for all consumers. */
export function layoutOf(m: Model): Layout {
  let w = m.width;
  let h = m.height;
  if (w <= 0) w = 80;
  if (h <= 0) h = 24;
  const l: Layout = { width: w, height: h, panelW: 0, leftW: 0, bodyH: 0, popupLines: 0 };
  l.panelW = panelWidth(w);
  l.leftW = w - l.panelW - 3; // vertical rule + sidebar padding
  if (l.leftW < 4) l.leftW = 4;
  l.popupLines = lineCount(popupView(m, w));

  let chrome = 6 + l.popupLines; // header+blank, divider, input, notice, help
  if (m.busy) chrome++; // spinner line
  l.bodyH = h - chrome;
  if (l.bodyH < 4) l.bodyH = 4;
  return l;
}

function lineCount(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length;
}

function tick(): Cmd {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ t: "tick" }), 120);
  });
}

/** update handles one message, mutating the model, returning follow-up cmds. */
export function update(m: Model, msg: unknown): Cmd[] {
  const kind = (msg as { t?: string }).t;
  switch (kind) {
    case "resize": {
      const { width, height } = msg as { width: number; height: number };
      m.width = width;
      m.height = height;
      m.msgIn.width = inputWidth(m.width);
      return [];
    }
    case "tick": {
      if (!m.busy) return [];
      m.spinner = (m.spinner + 1) % spinnerFrames.length;
      return [tick()];
    }
    case "wsEvent": {
      const wasBusy = m.busy;
      applyEvent(m, (msg as { ev: Event }).ev);
      const cmds: Cmd[] = [];
      if (m.busy && !wasBusy) cmds.push(tick());
      return cmds;
    }
    case "wsClosed": {
      m.client = null;
      m.connected = false;
      m.busy = false;
      m.transcript.push(tline(LineKind.Error, "서버 연결이 끊겼습니다"));
      return [];
    }
    case "projects": {
      const msgP = msg as ProjectsMsg;
      if (msgP.err) {
        m.notice = "프로젝트 조회 실패: " + msgP.err.message;
        return [];
      }
      if (m.menu !== null && m.menu.title === "프로젝트") {
        m.menu = menuProjects(msgP.list, m.project);
      }
      m.projects = msgP.list;
      return [];
    }
    case "models": {
      const msgM = msg as ModelsMsg;
      if (msgM.err) {
        m.notice = "모델 조회 실패: " + msgM.err.message;
        return [];
      }
      if (m.menu !== null && m.menu.title === "모델") {
        m.menu = menuModels(msgM.list, m.model);
      }
      return [];
    }
    case "machines": {
      const msgM = msg as MachinesMsg;
      if (msgM.err) {
        m.notice = "기기 조회 실패: " + msgM.err.message;
        return [];
      }
      if (m.menu !== null && m.menu.title === "서버") {
        m.menu = menuServer(m.connected, msgM.list);
      }
      return [];
    }
    case "role": {
      const msgR = msg as RoleMsg;
      if (!msgR.err) {
        m.provider = msgR.provider;
        m.model = msgR.model;
      }
      return [];
    }
    case "sessionsForProject": {
      const msgS = msg as SessionsForProjectMsg;
      if (msgS.err) {
        m.notice = msgS.err.message;
        return [];
      }
      m.sessionIDs = msgS.sessions;
      m.sessions = msgS.sessions.map((s) => s.name);
      if (msgS.sessions.length > 0) {
        const newest = msgS.sessions[0]!;
        m.currentSession = newest.id;
        const cmd = sendCmd(m.client, { type: "resume", sessionId: newest.id });
        return cmd ? [cmd] : [];
      }
      m.transcript.push(tline(LineKind.Notice, "이 프로젝트의 세션이 없습니다. /new 로 시작하세요"));
      return [];
    }
    case "usage": {
      const msgU = msg as UsageMsg;
      if (msgU.err) {
        m.notice = "사용량 조회 실패: " + msgU.err.message;
        return [];
      }
      m.tokens = msgU.prompt + msgU.completion;
      m.transcript.push(
        tline(LineKind.Notice, `세션 토큰 사용량 — 프롬프트 ${msgU.prompt} + 완성 ${msgU.completion} = ${msgU.prompt + msgU.completion}`),
      );
      return [];
    }
    case "actionDone": {
      const err = (msg as { err?: Error }).err;
      if (err) m.notice = err.message;
      return [];
    }
    case "connectResult": {
      const msgC = msg as { client?: import("./client.ts").WSClient; err?: Error };
      if (msgC.err || !msgC.client) {
        m.connected = false;
        m.transcript.push(tline(LineKind.Error, "연결 실패: " + (msgC.err?.message ?? "unknown")));
        return [];
      }
      m.client = msgC.client;
      m.connected = true;
      wire(m);
      saveServer(m.addr, m.token);
      m.transcript.push(tline(LineKind.Notice, "서버에 연결되었습니다"));
      return [fetchRole(m.addr, m.token), fetchMachines(m.addr, m.token)];
    }
    case "key":
      if (m.menu !== null) return updateMenu(m, msg as KeyMsg);
      return updateKeys(m, msg as KeyMsg);
    case "mouseWheel": {
      const mm = msg as MouseWheelMsg;
      const l = layoutOf(m);
      scrollBy(m, l.leftW, l.bodyH, mm.dy);
      return [];
    }
    default:
      return [];
  }
}

/** updateKeys handles keys on the main screen. */
function updateKeys(m: Model, msg: KeyMsg): Cmd[] {
  const items = candidates(m);
  const popupOpen = items.length > 0 && !m.popupGone;

  if (popupOpen) {
    switch (msg.type) {
      case "tab":
        // replace the input with the selected command
        m.msgIn.setValue(items[clampPopupSel(m, items.length)]!.left);
        return [];
      case "up":
      case "down": {
        m.popupSel += msg.type === "up" ? -1 : 1;
        const n = items.length;
        m.popupSel = ((m.popupSel % n) + n) % n;
        return [];
      }
      case "esc":
        m.popupGone = true;
        return [];
      case "enter": {
        const v = m.msgIn.getValue().replace(/\s+$/, "");
        if (items.length === 1 && items[0]!.left === v) {
          // exact match: fall through and execute below
          break;
        }
        const item = items[clampPopupSel(m, items.length)]!;
        m.msgIn.setValue(item.left + " ");
        m.popupSel = 0;
        m.popupGone = false;
        return [];
      }
    }
  }

  const l = layoutOf(m);
  switch (msg.type) {
    case "pgup":
      scrollBy(m, l.leftW, l.bodyH, -5);
      return [];
    case "pgdown":
      scrollBy(m, l.leftW, l.bodyH, 5);
      return [];
    case "ctrl+c":
      // clear the input line; quitting is /exit
      m.msgIn.setValue("");
      m.notice = "";
      return [];
    case "esc":
      // /stop surface behavior: consume quietly
      m.msgIn.setValue("");
      m.notice = "";
      return [];
    case "enter":
      return runCommand(m, m.msgIn.getValue());
    default: {
      m.msgIn.update(msg);
      m.msgIn.setValue(sanitizeInput(m.msgIn.getValue()));
      m.popupGone = false;
      m.popupSel = clampPopupSel(m, candidates(m).length);
      return [];
    }
  }
}

// afterConnect pulls role and machine data after a fresh connection.
export function afterConnect(m: Model): Cmd[] {
  return [fetchRole(m.addr, m.token), fetchMachines(m.addr, m.token)];
}

function wire(m: Model): void {
  if (!m.client) return;
  m.client.onEvent = (ev: Event) => m.send({ t: "wsEvent", ev });
  m.client.onClose = () => m.send({ t: "wsClosed" });
}

export { execAction };
