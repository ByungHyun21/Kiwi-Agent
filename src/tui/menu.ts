// Fullscreen menus (port of menu.go).

import type { Machine, Project, SessionInfo } from "../protocol.ts";
import { displayWidth } from "./ansi.ts";
import { truncate } from "./helpers.ts";
import { TextInput } from "./textinput.ts";
import { hintStyle, popupSelStyle, titleStyle, errStyle } from "./styles.ts";
import type { KeyMsg, Cmd } from "./term.ts";
import type { Model } from "./model.ts";
import { execAction } from "./cmdexec.ts";

/** MenuAction identifies what Enter triggers on a menu item. */
export const enum MenuAction {
  Close = 0,
  OpenProject = 1,
  NewProjectInput = 2,
  DeleteProjectConfirm = 3,
  ConnectInput = 4,
  Disconnect = 5,
  RegisterMachineInput = 6,
  SetModel = 7,
  RefreshModels = 8,
  SetGoalInput = 9,
  ClearGoal = 10,
  ResumeSession = 11,
  // extra actions that only exist after input/confirm
  OpenProjectCreate = 100,
  ConnectExec = 101,
  RegisterMachineExec = 102,
  SetGoalExec = 103,
  DeleteProjectExec = 104,
}

export interface MenuItem {
  label: string;
  desc: string;
  action: MenuAction;
  payload: string;
}

export const enum MenuMode {
  List = 0,
  Input = 1,
  Confirm = 2,
}

/** menu is the fullscreen submenu state (covers the conversation area). */
export class Menu {
  title: string;
  items: MenuItem[];
  sel = 0;
  mode = MenuMode.List;
  input = new TextInput();
  prompt = ""; // input label or confirm question
  act: MenuAction = MenuAction.Close; // action pending input/confirm
  arg = ""; // payload captured when the action started

  constructor(title: string, items: MenuItem[]) {
    this.title = title;
    this.items = items;
    this.input.prompt = "> ";
    this.input.charLimit = 400;
    this.input.focus();
  }

  clampSel(): void {
    if (this.sel < 0) this.sel = 0;
    if (this.sel >= this.items.length) this.sel = this.items.length - 1;
  }

  /** render draws the fullscreen menu inside width×height. */
  render(width: number, _height: number): string {
    this.clampSel();
    const body: string[] = [titleStyle.render(this.title), ""];

    switch (this.mode) {
      case MenuMode.Input:
        body.push(hintStyle.render(this.prompt), "", this.input.view());
        break;
      case MenuMode.Confirm:
        body.push(errStyle.render(this.prompt));
        break;
      default:
        this.items.forEach((it, i) => {
          let label = it.label;
          if (it.desc !== "") {
            let gap = width - 6 - displayWidth(label) - displayWidth(it.desc);
            if (gap < 2) gap = 2;
            label = label + " ".repeat(gap) + hintStyle.render(it.desc);
          }
          label = padTo(label, width - 4);
          if (i === this.sel) label = popupSelStyle.render(label);
          body.push(truncate(label, width - 2));
        });
        body.push("", hintStyle.render("↑↓ 이동 · Enter 선택 · Esc 닫기"));
    }
    return body.join("\n");
  }
}

function padTo(s: string, w: number): string {
  const gap = w - displayWidth(s);
  if (gap <= 0) return s;
  return s + " ".repeat(gap);
}

// ---- builders ----

export function menuProjects(list: Project[], current: string): Menu {
  const items: MenuItem[] = list.map((p) => ({
    label: p.name,
    desc: p.workdir + "@" + p.machine + (p.name === current ? " · 현재" : ""),
    action: MenuAction.OpenProject,
    payload: p.name,
  }));
  items.push(
    { label: "＋ 새 프로젝트", desc: "", action: MenuAction.NewProjectInput, payload: "" },
    { label: "✕ 삭제…", desc: "", action: MenuAction.DeleteProjectConfirm, payload: current },
  );
  return new Menu("프로젝트", items);
}

export function menuServer(connected: boolean, machines: Machine[]): Menu {
  const items: MenuItem[] = [{ label: "연결…", desc: "주소:포트 토큰", action: MenuAction.ConnectInput, payload: "" }];
  if (connected) {
    items[0]!.desc = "주소:포트 토큰 (현재 연결됨)";
    items.push({ label: "연결 끊기", desc: "", action: MenuAction.Disconnect, payload: "" });
  }
  for (const mc of machines) {
    items.push({ label: "▤ " + mc.name, desc: `${mc.user}@${mc.host} · ${mc.state}`, action: MenuAction.Close, payload: "" });
  }
  items.push({ label: "▤ 기기 등록…", desc: "이름 호스트 포트 사용자", action: MenuAction.RegisterMachineInput, payload: "" });
  return new Menu("서버", items);
}

export function menuModels(models: string[], current: string): Menu {
  const items: MenuItem[] = models.map((m) => ({
    label: m,
    desc: m === current ? "· 현재" : "",
    action: MenuAction.SetModel,
    payload: m,
  }));
  items.push({ label: "↻ 새로고침", desc: "", action: MenuAction.RefreshModels, payload: "" });
  return new Menu("모델", items);
}

export function menuGoal(goal: string): Menu {
  const items: MenuItem[] = [{ label: "목표 설정…", desc: goal, action: MenuAction.SetGoalInput, payload: "" }];
  if (goal !== "") {
    items.push({ label: "목표 지우기", desc: "", action: MenuAction.ClearGoal, payload: "" });
  }
  return new Menu("목표", items);
}

export function menuSessions(sessions: SessionInfo[]): Menu {
  const items: MenuItem[] = sessions.map((s) => ({
    label: s.name || s.id,
    desc: fmtMD(s.updatedAt),
    action: MenuAction.ResumeSession,
    payload: s.id,
  }));
  return new Menu("세션 이어하기", items);
}

function fmtMD(t: Date | undefined): string {
  if (!t || Number.isNaN(t.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// ---- key handling ----

/** updateMenu handles keys while the menu is open. */
export function updateMenu(m: Model, msg: KeyMsg): Cmd[] {
  const mu = m.menu!;
  switch (mu.mode) {
    case MenuMode.List: {
      switch (msg.type) {
        case "esc":
          m.menu = null;
          return [];
        case "up":
          mu.sel--;
          break;
        case "down":
        case "tab":
          mu.sel++;
          break;
        case "enter": {
          mu.clampSel();
          const item = mu.items[mu.sel]!;
          return startAction(m, item.action, item.payload);
        }
        default:
          return [];
      }
      mu.clampSel();
      return [];
    }
    case MenuMode.Input: {
      switch (msg.type) {
        case "esc":
          mu.mode = MenuMode.List;
          mu.input.setValue("");
          return [];
        case "enter": {
          const val = mu.input.getValue().trim();
          if (val === "") return [];
          const act = mu.act;
          const arg = mu.arg;
          m.menu = null;
          return execAction(m, act, arg, val);
        }
        default: {
          mu.input.update(msg);
          return [];
        }
      }
    }
    case MenuMode.Confirm: {
      switch (msg.str) {
        case "enter":
        case "y":
        case "Y": {
          const act = mu.act;
          const arg = mu.arg;
          m.menu = null;
          return execAction(m, act, arg, "");
        }
        case "esc":
        case "n":
        case "N":
          mu.mode = MenuMode.List;
          return [];
        default:
          return [];
      }
    }
  }
  return [];
}

/** startAction switches to input/confirm modes or executes immediately. */
export function startAction(m: Model, act: MenuAction, payload: string): Cmd[] {
  const mu = m.menu!;
  switch (act) {
    case MenuAction.NewProjectInput:
      mu.mode = MenuMode.Input;
      mu.prompt = "새 프로젝트 이름 (Esc 취소)";
      mu.act = MenuAction.OpenProjectCreate;
      mu.arg = payload;
      mu.input.setValue("");
      return [];
    case MenuAction.ConnectInput:
      mu.mode = MenuMode.Input;
      mu.prompt = "서버 주소:포트 토큰 (Esc 취소)";
      mu.act = MenuAction.ConnectExec;
      mu.arg = payload;
      mu.input.setValue("");
      return [];
    case MenuAction.RegisterMachineInput:
      mu.mode = MenuMode.Input;
      mu.prompt = "기기: 이름 호스트 포트 사용자 (Esc 취소)";
      mu.act = MenuAction.RegisterMachineExec;
      mu.arg = payload;
      mu.input.setValue("");
      return [];
    case MenuAction.SetGoalInput:
      mu.mode = MenuMode.Input;
      mu.prompt = "목표 한 줄 (Esc 취소)";
      mu.act = MenuAction.SetGoalExec;
      mu.arg = payload;
      mu.input.setValue("");
      return [];
    case MenuAction.DeleteProjectConfirm:
      mu.mode = MenuMode.Confirm;
      mu.prompt = `프로젝트 '${payload}' 등록을 삭제할까요? (Enter 삭제 · Esc 취소) — 실제 폴더는 유지됩니다`;
      mu.act = MenuAction.DeleteProjectExec;
      mu.arg = payload;
      return [];
    default:
      m.menu = null;
      return execAction(m, act, payload, "");
  }
}
