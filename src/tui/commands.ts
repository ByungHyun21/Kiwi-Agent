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
  { name: "/resume", alias: "" },
  { name: "/stop", alias: "esc" },
  { name: "/server", alias: "" },
  { name: "/exit", alias: "" },
  { name: "/skill", alias: "" },
  { name: "/model", alias: "" },
  { name: "/btw", alias: "" },
  { name: "/update", alias: "" },
  { name: "/goal", alias: "" },
  { name: "/queue", alias: "/q" },
  { name: "/usage", alias: "" },
  { name: "/git", alias: "" },
  { name: "/mcp", alias: "" },
  { name: "/compact", alias: "" },
  { name: "/rename", alias: "" },
  { name: "/init", alias: "" },
  { name: "/language", alias: "" },
];

export const gitSubcommands = ["branch", "fork", "commit", "log", "status"];

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

  if (v.startsWith("/language ")) {
    const arg = v.slice("/language ".length);
    if (arg === "") {
      return langOrder.map((l) => ({ left: `/language ${l}`, name: l, alias: "", desc: langNames[l] }));
    }
    if (arg.includes(" ")) return [];
    return langOrder
      .filter((l) => l.startsWith(arg))
      .map((l) => ({ left: `/language ${l}`, name: l, alias: "", desc: langNames[l] }));
  }

  if (v.startsWith("/git ")) {
    const arg = v.slice("/git ".length);
    if (arg === "") {
      return gitSubcommands.map((s) => ({ left: `/git ${s}`, name: s, alias: "", desc: "" }));
    }
    if (arg.includes(" ")) return [];
    return gitSubcommands
      .filter((s) => s.startsWith(arg))
      .map((s) => ({ left: `/git ${s}`, name: s, alias: "", desc: "" }));
  }

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
