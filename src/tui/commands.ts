// Command popup: candidate list derived from the current input.

import { translations, langOrder, langNames } from "./lang.ts";
import type { Model } from "./model.ts";

/** command describes one slash command shown in the popup. */
export interface Command {
  name: string;
  alias: string; // optional short form shown in the popup
}

export const commands: Command[] = [
  { name: "/project", alias: "" },
  { name: "/new", alias: "" },
  { name: "/server", alias: "" },
  { name: "/session", alias: "" },
  { name: "/cd", alias: "" },
  { name: "/cat", alias: "" },
  { name: "/model", alias: "" },
  { name: "/btw", alias: "" },
  { name: "/update", alias: "" },
  { name: "/goal", alias: "" },
  { name: "/compact", alias: "" },
  { name: "/language", alias: "" },
  { name: "/exit", alias: "" },
  { name: "/skill", alias: "" },
  { name: "/git", alias: "" },
  { name: "/mcp", alias: "" },
  { name: "/init", alias: "" },
];

export const gitSubcommands = ["branch", "fork", "commit", "log", "status"];
export const sessionSubcommands = ["new", "cd", "host", "rename", "resume"];
export const projectSubcommands = ["new"];
export const serverSubcommands = ["open"];

/** popupItem is one row of the command popup. */
export interface PopupItem {
  left: string; // completion text
  name: string; // display name column
  alias: string; // display shortcut column
  desc: string;
}

/** candidates derives popup rows from the current input. */
export function candidates(m: Model): PopupItem[] {
  const v = m.msgIn.getValue();
  if (!v.startsWith("/")) return [];

  if (m.pathCands && v.startsWith(m.pathCands.replaceFrom)) {
    return m.pathCands.items.map((c) => ({ left: m.pathCands!.replaceFrom + c, name: c, alias: "", desc: "" }));
  }

  const sub = (head: string, subs: string[]): PopupItem[] => {
    const rest = v.slice(head.length);
    if (rest === "") return subs.map((s) => ({ left: head + s, name: s, alias: "", desc: "" }));
    if (rest.includes(" ")) return [];
    return subs.filter((s) => s.startsWith(rest)).map((s) => ({ left: head + s, name: s, alias: "", desc: "" }));
  };

  if (v.startsWith("/language ")) return sub("/language ", langOrder).map((it) => ({ ...it, name: it.name, desc: langNames[it.name as keyof typeof langNames] ?? "" }));
  if (v.startsWith("/git ")) return sub("/git ", gitSubcommands);
  if (v.startsWith("/project ")) return sub("/project ", projectSubcommands);
  if (v.startsWith("/server ")) return sub("/server ", serverSubcommands);
  if (v.startsWith("/session ") && !v.startsWith("/session cd ")) return sub("/session ", sessionSubcommands);

  if (v.includes(" ")) return []; // command already complete, typing arguments
  const t = translations[m.lang];
  const items: PopupItem[] = [];
  for (const c of commands) {
    if (c.name.startsWith(v) || (c.alias !== "" && c.alias.startsWith(v))) {
      items.push({ left: c.name, name: c.name, alias: c.alias, desc: t.CmdDescs[c.name] ?? "" });
    }
  }
  return items;
}
