// Model: the TUI state (port of model.go).

import type { Machine, Project, SessionInfo } from "../protocol.ts";
import { TextInput } from "./textinput.ts";
import { loadConfig } from "./config.ts";
import { defaultLang, translations, type Lang, validLang } from "./lang.ts";
import { LineKind } from "./transcript.ts";
import type { WSClient } from "./client.ts";
import type { Menu } from "./menu.ts";

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Model {
  // connection
  msgIn = new TextInput();
  addr = "";
  token = "";
  client: WSClient | null = null;
  connected = false;

  // live session state (mirrors the server panel)
  project = "";
  machine = "";
  model = "";
  provider = "";
  goal = "";
  todos: string[] = [];
  ctxUsed = 0;
  ctxMax = 0;
  tokens = 0;
  curTool = ""; // tool currently executing (spinner hint)

  // server-side lists
  sessions: string[] = [];
  sessionIDs: SessionInfo[] = [];
  currentSession = "";
  projects: Project[] = [];
  machines: Machine[] = [];
  wantProject = "";

  // transcript
  transcript: import("./transcript.ts").TLine[] = [];
  streamKind = -1;
  scroll = -1; // -1 = follow bottom
  toolArgsName = ""; // name of the call whose args are streaming
  busy = false;
  spinner = 0;

  // ui chrome
  lang: Lang = defaultLang;
  notice = "";
  popupSel = 0;
  popupGone = false;
  menu: Menu | null = null;
  width = 0;
  height = 0;

  /** send pushes a message into the program loop (set by run()). */
  send: (msg: unknown) => void = () => {};

  t(): (typeof translations)[Lang] {
    return translations[this.lang];
  }

  hasServer(): boolean {
    return this.addr !== "";
  }

  /** machineDefault / workdirDefault fill project creation defaults. */
  machineDefault(): string {
    return "local";
  }

  workdirDefault(): string {
    const home = process.env.HOME ?? ".";
    return `${home}/Desktop/workspace/${this.wantProject}`;
  }
}

/** New returns the initial model, starting directly at the main screen. */
export function newModel(): Model {
  const cfg = loadConfig();
  const m = new Model();
  m.lang = validLang(cfg.language) ? cfg.language : defaultLang;
  m.msgIn.placeholder = translations[m.lang].Placeholder;
  m.msgIn.prompt = "> ";
  m.msgIn.charLimit = 4000;
  m.msgIn.focus();
  m.addr = cfg.server ?? "";
  m.token = cfg.token ?? "";
  m.scroll = -1;
  return m;
}

/** Run starts the kiwi terminal client. */
export async function run(): Promise<void> {
  const { Program } = await import("./term.ts");
  const { dialServer } = await import("./client.ts");
  const { update } = await import("./update.ts");
  const { view } = await import("./view.ts");

  const m = newModel();
  const program = new Program({
    update(msg) {
      return update(m, msg);
    },
    view() {
      return view(m);
    },
  });
  m.send = (msg) => program.send(msg);

  // auto-connect when a server is configured (Init in the Go version)
  if (m.addr !== "" && m.token !== "") {
    void Promise.resolve(dialServer(m.addr, m.token)).then((msg) => program.send(msg));
  }

  await program.run();
}

export { LineKind };
