// Slash command execution (port of cmdexec.go).

import type { ClientMsg } from "../protocol.ts";
import { tline, LineKind } from "./transcript.ts";
import { hintStyle } from "./styles.ts";
import {
  sendCmd,
  postJSON,
  getJSON,
  restURL,
  fetchProjects,
  fetchModels,
  fetchMachines,
  fetchSessionsForProject,
  fetchUsage,
  dialServer,
  type ActionDoneMsg,
} from "./client.ts";
import { MenuAction, menuGoal, menuModels, menuProjects, menuServer, menuSessions } from "./menu.ts";
import { saveLang } from "./config.ts";
import { langNames, validLang } from "./lang.ts";
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
      return cmdProject(m);
    case "/model":
      return cmdModel(m);
    case "/goal":
      return cmdGoal(m, fields);
    case "/new":
      return cmdNew(m, fields);
    case "/resume":
      return cmdResume(m);
    case "/stop":
      return cmdStop(m);
    case "/compact":
      return cmdCompact(m);
    case "/btw":
      return cmdBtw(m, fields);
    case "/queue":
      return cmdQueue(m, fields);
    case "/rename":
      return cmdRename(m, fields);
    case "/usage":
      return cmdUsage(m);
    case "/language":
      return cmdLanguage(m, fields);
    default:
      // unlisted commands (init, skill, mcp, git, update…) are consumed quietly
      m.notice = "";
      return [];
  }
}

/** sendMessage appends the user line and ships it, mapping "." to continue. */
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

/** requireConn guards commands that need a live connection. */
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
  if (fields.length >= 3) {
    return execAction(m, MenuAction.ConnectExec, "", fields.slice(1).join(" "));
  }
  if (fields.length === 2) {
    // /server token-only hint
    m.notice = m.t().ServerUsage;
    return [];
  }
  m.menu = menuServer(m.connected, m.machines);
  if (!m.hasServer()) return [];
  return orEmpty(fetchMachines(m.addr, m.token));
}

function cmdProject(m: Model): Cmd[] {
  if (!m.hasServer()) {
    m.notice = "먼저 /server 로 연결하세요";
    return [];
  }
  m.menu = menuProjects(m.projects, m.project);
  return orEmpty(fetchProjects(m.addr, m.token));
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

function cmdNew(m: Model, fields: string[]): Cmd[] {
  if (!requireConn(m)) return [];
  // a fresh session starts on a blank screen
  m.transcript = [];
  m.streamKind = -1;
  m.scroll = -1;
  return orEmpty(sendCmd(m.client, { type: "new", text: arg(fields) }));
}

function cmdResume(m: Model): Cmd[] {
  if (!requireConn(m)) return [];
  m.menu = menuSessions(m.sessionIDs);
  return orEmpty(sendCmd(m.client, { type: "sessions" }));
}

function cmdStop(m: Model): Cmd[] {
  if (!m.client) return [];
  return orEmpty(sendCmd(m.client, { type: "stop" }));
}

function cmdCompact(m: Model): Cmd[] {
  if (!requireConn(m)) return [];
  return orEmpty(sendCmd(m.client, { type: "compact" }));
}

function cmdBtw(m: Model, fields: string[]): Cmd[] {
  if (fields.length < 2) {
    m.notice = "사용법: /btw <질문>";
    return [];
  }
  if (!requireConn(m)) return [];
  return orEmpty(sendCmd(m.client, { type: "btw", text: arg(fields) }));
}

function cmdQueue(m: Model, fields: string[]): Cmd[] {
  if (fields.length < 2) {
    m.notice = "사용법: /queue <프롬프트>";
    return [];
  }
  if (!requireConn(m)) return [];
  // the server queues MsgSend while a turn is running
  return orEmpty(sendCmd(m.client, { type: "send", text: arg(fields) } satisfies ClientMsg));
}

function cmdRename(m: Model, fields: string[]): Cmd[] {
  if (fields.length < 2 || m.currentSession === "") {
    m.notice = "사용법: /rename <이름> (세션 열린 상태에서)";
    return [];
  }
  const name = arg(fields);
  const cmd: Cmd = postJSON("PATCH", restURL(m.addr, `/api/sessions/${encodeURIComponent(m.currentSession)}`), m.token, { name }).then(done, toErr);
  return [cmd];
}

function cmdUsage(m: Model): Cmd[] {
  if (m.currentSession === "") {
    m.notice = "열린 세션이 없습니다";
    return [];
  }
  return orEmpty(fetchUsage(m.addr, m.token, m.currentSession));
}

function cmdLanguage(m: Model, fields: string[]): Cmd[] {
  const t = m.t();
  if (fields.length < 2 || !validLang(fields[1]!)) {
    m.notice = hintStyle.render(t.LanguageUsage);
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
        // resume the newest session of this project, or start fresh
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
