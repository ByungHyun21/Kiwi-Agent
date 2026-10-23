// Slash-command definitions shared by the web composer and the server.
// Adding a command means adding one spec here plus a handler in the layer
// that owns it (web client or SessionRuntime). Parsing and hints stay common.

/** SlashTarget says which side performs the command. */
export type SlashTarget = "client" | "server";

/** SlashCommandSpec describes one slash command for parsing and UI hints. */
export interface SlashCommandSpec {
  name: string;
  usage: string;
  description: string;
  target: SlashTarget;
  /** Valid argument values, used by hints and server-side validation. */
  args?: readonly string[];
  /** Gray hint shown after the command while the argument is still empty. */
  hint?: string;
  /** The web UI opens a picker when the command has no argument. */
  menuWhenEmpty?: boolean;
  /** Control commands may run while the agent is streaming. */
  runWhileBusy?: boolean;
}

/** Slash commands known to Kiwi. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "think",
    usage: "/think {on|off|low|medium|high|xhigh|max}",
    description: "세션 추론 레벨 변경",
    target: "server",
    args: ["auto", "off", "on", "low", "medium", "high", "xhigh", "max"],
    hint: "on | off | low | medium | high | xhigh | max",
    menuWhenEmpty: true,
    runWhileBusy: true,
  },
  {
    name: "model",
    usage: "/model",
    description: "모델 선택",
    target: "client",
    menuWhenEmpty: true,
    runWhileBusy: true,
  },
  {
    name: "new",
    usage: "/new",
    description: "새 세션",
    target: "client",
  },
];

const COMMANDS = new Map(SLASH_COMMANDS.map((spec) => [spec.name, spec]));

/** ParsedSlashCommand is one parsed known or unknown command. */
export interface ParsedSlashCommand {
  name: string;
  args: string[];
  arg: string; // raw argument text after the command name
  raw: string;
  spec?: SlashCommandSpec;
}

/** parseSlashCommand recognizes "/name args" without treating paths as commands. */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const raw = input.trim();
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(raw);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const arg = (match[2] ?? "").trim();
  return {
    name,
    args: arg === "" ? [] : arg.split(/\s+/),
    arg,
    raw,
    spec: COMMANDS.get(name),
  };
}

/** SlashHint is the gray autocomplete text shown after the typed draft. */
export interface SlashHint {
  spec: SlashCommandSpec;
  text: string;
}

/** slashHint returns the gray completion for a known command, if any. */
export function slashHint(input: string): SlashHint | null {
  const cmd = parseSlashCommand(input);
  if (!cmd?.spec) return null;
  const spec = cmd.spec;

  if (cmd.args.length === 0) {
    return spec.hint ? { spec, text: " " + spec.hint } : null;
  }

  // Complete a unique partial argument (e.g. "/think me" -> "dium").
  if (cmd.args.length === 1 && spec.args && !/\s$/.test(input)) {
    const partial = cmd.args[0]!.toLowerCase();
    const matches = spec.args.filter((arg) => arg.startsWith(partial));
    if (matches.length === 1) return { spec, text: matches[0]!.slice(partial.length) };
  }
  return null;
}
