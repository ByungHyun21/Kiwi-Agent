// Slash command execution: T04 command set (project/new/server/exit/model/
// btw/update/goal/compact/language/session/cd/cat + deferred stubs).

import type { ClientMsg, Machine } from "../protocol.ts";
import { tline, LineKind } from "./transcript.ts";
import { commands } from "./commands.ts";
import {
  sendCmd,
  postJSON,
  getJSON,
  restURL,
  fetchProjects,
  fetchModels,
  fetchMachines,
  fetchSessionsForProject,
  dialServer,
  type ActionDoneMsg,
} from "./client.ts";
import { MenuAction, menuGoal, menuModels, menuProjects, menuServer, menuSessions } from "./menu.ts";
import { saveLang } from "./config.ts";
import { langNames, validLang } from "./lang.ts";
import { selfUpdate } from "../updater.ts";
import type { Model } from "./model.ts";
import type { Cmd } from "./term.ts";

function done(err?: unknown): Promise<ActionDoneMsg> {
  return Promise.resolve(
    err === undefined
      ? ({ t: "actionDone" } satisfies ActionDoneMsg)
      : ({ t: "actionDone", err: err instanceof Error ? err : new Error(String(err)) } satisfies ActionDoneMsg),
  );
}

function toErr(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** runCommand executes a slash command or sends a plain message. */
export function runCommand(m: Model, raw: string): Cmd[] {
  const line = raw.trim();
  if (!line.startsWith("/")) {
    return sendMessage(m, line);
  }
  const fields = line.split(/\s+/).filter(Boolean);
  m.msgIn.setValue("");
  switch (fields[0]) {
    case "/exit":
      m.send({ t: "quit" });
      return [];
    case "/server":
      return cmdServer(m, fields);
    case "/project":
      return cmdProject(m, fields);
    case "/new":
      return cmdNew(m, fields);
    case "/session":
      return cmdSession(m, fields);
    case "/cd":
      return cmdCd(m, fields);
    case "/cat":
      return cmdCat(m, fields);
    case "/model":
      return cmdModel(m);
    case "/goal":
      return cmdGoal(m, fields);
    case "/btw":
      return cmdBtw(m, fields);
    case "/compact":
      return cmdCompact(m);
    case "/update":
      return cmdUpdate(m);
    case "/language":
      return cmdLanguage(m, fields);
    default:
      return unknownCommand(m, fields[0] ?? "");
  }
}

function unknownCommand(m: Model, name: string): Cmd[] {
  const known = commands.map((c) => c.name);
  const suggestions = known
    .filter((c) => c.slice(1, 3) === name.slice(1, 3) || c.startsWith(name.slice(0, 3)))
    .slice(0, 3);
  m.notice = suggestions.length > 0
    ? `알 수 없는 명령: ${name} — 가까운 명령: ${suggestions.join(" ")}`
    : `알 수 없는 명령: ${name}`;
  return [];
}

/** sendMessage appends the user line and ships it (mid-turn messages join the running turn). */
export function sendMessage(m: Model, text: string): Cmd[] {
  if (text === "") return [];
  if (text === ".") text = "continue";
  m.transcript.push(tline(LineKind.User, text));
  m.msgIn.setValue("");
  m.notice = "";
  if (!m.client) {
    m.transcript.push(tline(LineKind.Error, "서버에 연결되어 있지 않습니다. /server 로 연결하세요."));
    return [];
  }
  return orEmpty(sendCmd(m.client, { type: "send", text }));
}

function requireConn(m: Model): boolean {
  if (m.client) return true;
  m.notice = "서버에 연결되어 있지 않습니다";
  return false;
}

function arg(fields: string[]): string {
  return fields.slice(1).join(" ");
}

function orEmpty(cmd: Cmd): Cmd[] {
  return cmd ? [cmd] : [];
}

function cmdServer(m: Model, fields: string[]): Cmd[] {
  if (fields.length >= 2 && fields[1] === "open") {
    const addr = m.addr !== "" ? m.addr : "localhost:5494";
    m.transcript.push(tline(LineKind.Notice, `웹 UI: \x1b]8;;http://${addr}\x1b\\${addr}\x1b]8;;\x1b\\`));
    return [];
  }
  if (fields.length >= 3) {
    return execAction(m, MenuAction.ConnectExec, "", fields.slice(1).join(" "));
  }
  if (fields.length === 2) {
    m.notice = m.t().ServerUsage;
    return [];
  }
  m.menu = menuServer(m.connected, m.machines);
  if (!m.hasServer()) return [];
  return orEmpty(fetchMachines(m.addr, m.token));
}

function cmdProject(m: Model, fields: string[]): Cmd[] {
  if (fields.length >= 2 && fields[1] === "new") {
    return cmdProjectNew(m, fields.slice(2).join(" "));
  }
  if (!m.hasServer()) {
    m.notice = "먼저 /server 로 연결하세요";
    return [];
  }
  m.menu = menuProjects(m.projects, m.project);
  return orEmpty(fetchProjects(m.addr, m.token));
}

function cmdProjectNew(m: Model, name: string): Cmd[] {
  if (!m.hasServer()) {
    m.notice = "먼저 /server 로 연결하세요";
    return [];
  }
  if (name === "") {
    m.startInlinePrompt("프로젝트 이름은?", false, (value) => {
      m.wantProject = value;
      createProject(m, value);
    });
    return [];
  }
  m.wantProject = name;
  return createProject(m, name);
}

function createProject(m: Model, name: string): Cmd[] {
  return [postJSON("POST", restURL(m.addr, "/api/projects"), m.token, {
    name,
    machine: m.machineDefault(),
    workdir: m.workdirDefault(),
  }).then(done, toErr)];
}

function cmdNew(m: Model, fields: string[]): Cmd[] {
  if (!requireConn(m)) return [];
  m.transcript = [];
  m.streamKind = -1;
  m.scroll = -1;
  m.catView = null;
  return orEmpty(sendCmd(m.client, { type: "new", text: arg(fields) }));
}

function cmdCd(m: Model, fields: string[]): Cmd[] {
  const p = arg(fields);
  if (p === "") {
    m.notice = "사용법: /cd <경로>";
    return [];
  }
  if (!requireConn(m) || m.currentSession === "") return [];
  return orEmpty(sendCmd(m.client, { type: "session_cd", text: p } satisfies ClientMsg));
}

function cmdCat(m: Model, fields: string[]): Cmd[] {
  const p = arg(fields);
  if (p === "") {
    m.notice = "사용법: /cat <파일>";
    return [];
  }
  if (!requireConn(m)) return [];
  return orEmpty(sendCmd(m.client, { type: "cat", text: p } satisfies ClientMsg));
}

function cmdSession(m: Model, fields: string[]): Cmd[] {
  const sub = fields[1] ?? "";
  switch (sub) {
    case "": {
      if (!requireConn(m)) return [];
      m.menu = menuSessions(m.sessionIDs);
      return orEmpty(sendCmd(m.client, { type: "sessions" }));
    }
    case "new":
      return cmdNew(m, ["new", ...fields.slice(2)]);
    case "cd":
      return cmdCd(m, ["cd", ...fields.slice(2)]);
    case "resume": {
      if (!requireConn(m)) return [];
      m.menu = menuSessions(m.sessionIDs);
      return orEmpty(sendCmd(m.client, { type: "sessions" }));
    }
    case "rename": {
      const name = fields.slice(2).join(" ");
      if (name === "" || m.currentSession === "") {
        m.notice = "사용법: /session rename <이름> (세션 열린 상태에서)";
        return [];
      }
      const cmd: Cmd = postJSON("PATCH", restURL(m.addr, `/api/sessions/${encodeURIComponent(m.currentSession)}`), m.token, { name }).then(done, toErr);
      return [cmd];
    }
    case "host": {
      const target = fields[2] ?? "";
      if (target === "") {
        m.notice = "사용법: /session host <ip또는머신이름>";
        return [];
      }
      if (!requireConn(m) || m.currentSession === "") return [];
      return cmdSessionHost(m, target);
    }
    default:
      return unknownCommand(m, "/session " + sub);
  }
}

function cmdSessionHost(m: Model, target: string): Cmd[] {
  const known = m.machines.find((mach) => mach.name === target);
  const finish = () => {
    if (m.client) {
      m.send({ t: "actionDone" });
      orEmpty(sendCmd(m.client, { type: "session_host", text: known ? known.name : target }));
    }
  };
  if (known) {
    finish();
    return [];
  }
  m.startInlinePrompt(`사용자명 (${target})`, false, (user) => {
    if (user === "") return;
    m.startInlinePrompt(`비밀번호 (${user}@${target})`, true, async (password) => {
      if (password === "") return;
      try {
        const machine: Machine = { name: target, host: target, port: 22, user, state: "" };
        await postJSON("POST", restURL(m.addr, "/api/machines"), m.token, machine);
        await postJSON("PUT", restURL(m.addr, `/api/machines/${encodeURIComponent(target)}/auth`), m.token, { user, password });
        finish();
      } catch (err) {
        m.notice = "머신 등록 실패: " + String(err);
      }
    });
  });
  return [];
}

function cmdModel(m: Model): Cmd[] {
  if (!m.hasServer()) {
    m.notice = "먼저 /server 로 연결하세요";
    return [];
  }
  m.menu = menuModels([], m.model);
  return orEmpty(fetchModels(m.addr, m.token));
}

function cmdGoal(m: Model, fields: string[]): Cmd[] {
  if (fields.length >= 2) {
    return execAction(m, MenuAction.SetGoalExec, "", arg(fields));
  }
  m.menu = menuGoal(m.goal);
  return [];
}

function cmdBtw(m: Model, fields: string[]): Cmd[] {
  if (fields.length < 2) {
    if (!requireConn(m) || m.currentSession === "") {
      m.notice = "사용법: /btw <질문>";
      return [];
    }
    m.wantBtwPicker = true;
    return orEmpty(sendCmd(m.client, { type: "btw_sides" }));
  }
  if (!requireConn(m)) return [];
  return orEmpty(sendCmd(m.client, { type: "btw", text: arg(fields) }));
}

function cmdCompact(m: Model): Cmd[] {
  if (!requireConn(m)) return [];
  return orEmpty(sendCmd(m.client, { type: "compact" }));
}

function cmdUpdate(m: Model): Cmd[] {
  m.notice = "업데이트 확인 중…";
  void (async () => {
    const res = await selfUpdate();
    switch (res.status) {
      case "updated":
        m.notice = `${res.tag} 업데이트 완료 — /exit 후 다시 실행하면 적용됩니다`;
        break;
      case "failed":
        m.notice = "업데이트 실패: " + res.reason;
        break;
      case "current":
        m.notice = "이미 최신 버전입니다";
        break;
    }
  })();
  return [];
}

function cmdLanguage(m: Model, fields: string[]): Cmd[] {
  const t = m.t();
  if (fields.length < 2 || !validLang(fields[1]!)) {
    m.notice = t.LanguageUsage;
    return [];
  }
  m.lang = fields[1] as Model["lang"];
  m.msgIn.placeholder = m.t().Placeholder;
  m.notice = m.t().LanguageChanged(langNames[m.lang]);
  try {
    saveLang(m.lang);
  } catch (err) {
    m.notice = m.t().SaveFailed + ": " + String(err);
  }
  return [];
}

/** execAction performs the menu/slash actions (port of Model.execAction). */
export function execAction(m: Model, act: MenuAction, payload: string, input: string): Cmd[] {
  switch (act) {
    case MenuAction.Close:
      return [];
    case MenuAction.OpenProject: {
      m.notice = "";
      m.wantProject = payload;
      m.project = payload;
      const cmds: Cmd[] = [];
      if (m.client) {
        cmds.push(...orEmpty(sendCmd(m.client, { type: "project", text: payload })));
        cmds.push(fetchSessionsForProject(m.addr, m.token, payload));
      }
      return cmds;
    }
    case MenuAction.OpenProjectCreate:
      return [postJSON("POST", restURL(m.addr, "/api/projects"), m.token, {
        name: input,
        machine: m.machineDefault(),
        workdir: m.workdirDefault(),
      }).then(done, toErr)];
    case MenuAction.DeleteProjectExec:
      return [
        (async (): Promise<unknown> => {
          try {
            const list = await getJSON<Array<{ id: number; name: string }>>(restURL(m.addr, "/api/projects"), m.token);
            for (const p of list) {
              if (p.name === payload) {
                return postJSON("DELETE", restURL(m.addr, `/api/projects/${p.id}`), m.token).then(done, toErr);
              }
            }
            return done(new Error(`프로젝트를 찾을 수 없습니다: ${payload}`));
          } catch (err) {
            return done(toErr(err));
          }
        })(),
      ];
    case MenuAction.ConnectInput:
    case MenuAction.ConnectExec: {
      const fields = input.split(/\s+/).filter(Boolean);
      if (fields.length < 2) {
        m.notice = "사용법: 주소:포트 토큰";
        return [];
      }
      m.addr = fields[0]!;
      m.token = fields[1]!;
      m.connected = false;
      return orEmpty(dialServer(m.addr, m.token));
    }
    case MenuAction.Disconnect:
      m.client?.close();
      m.client = null;
      m.connected = false;
      m.busy = false;
      return [];
    case MenuAction.RegisterMachineExec: {
      const f = input.split(/\s+/).filter(Boolean);
      if (f.length < 3) {
        m.notice = "사용법: 이름 호스트 [포트] 사용자";
        return [];
      }
      const machine = { name: f[0]!, host: f[1]!, user: f[f.length - 1]!, port: 22, state: "" };
      if (f.length >= 4) {
        const port = parseInt(f[2]!, 10);
        if (Number.isFinite(port)) machine.port = port;
      }
      return [postJSON("POST", restURL(m.addr, "/api/machines"), m.token, machine).then(done, toErr)];
    }
    case MenuAction.SetModel:
      return [
        postJSON("PUT", restURL(m.addr, "/api/roles/agent-chat"), m.token, { provider: m.provider, model: payload }).then(
          () => {
            m.model = payload;
            return done();
          },
          toErr,
        ),
      ];
    case MenuAction.RefreshModels:
      return orEmpty(fetchModels(m.addr, m.token));
    case MenuAction.SetGoalExec:
      if (m.client) {
        m.goal = input;
        return orEmpty(sendCmd(m.client, { type: "set_goal", text: input }));
      }
      m.notice = "서버에 연결되어 있지 않습니다";
      return [];
    case MenuAction.ClearGoal:
      m.goal = "";
      if (m.client) {
        return orEmpty(sendCmd(m.client, { type: "set_goal", text: "" }));
      }
      return [];
    case MenuAction.BtwNewSide:
      m.startInlinePrompt("새 사이드 질문", false, (value) => {
        if (m.client) orEmpty(sendCmd(m.client, { type: "btw", text: value }));
      });
      return [];
    case MenuAction.BtwOpenSide:
      m.startInlinePrompt("사이드 이어서 질문", false, (value) => {
        if (m.client) orEmpty(sendCmd(m.client, { type: "btw", text: value, sessionId: payload }));
      });
      return [];
    case MenuAction.ResumeSession: {
      for (const s of m.sessionIDs) {
        if (s.id === payload) m.currentSession = s.id;
      }
      if (m.client) {
        return orEmpty(sendCmd(m.client, { type: "resume", sessionId: payload }));
      }
      return [];
    }
    default:
      return [];
  }
}
