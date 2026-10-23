// Server-side slash commands. The shared spec in src/shared/slash.ts marks a
// command as target:"server"; this file maps it to an implementation. New
// server commands only need a handler here.

import { isThinkLevel, type ThinkLevel } from "../shared/protocol.ts";
import type { ParsedSlashCommand } from "../shared/slash.ts";

/** ServerCommandContext is the narrow runtime surface commands may use. */
export interface ServerCommandContext {
  setThink(level: ThinkLevel): void;
  notice(text: string): void;
  error(text: string): void;
}

type ServerCommandHandler = (ctx: ServerCommandContext, cmd: ParsedSlashCommand) => void;

const handlers: Record<string, ServerCommandHandler> = {
  think(ctx, cmd) {
    if (cmd.args.length > 1) {
      ctx.error(`사용법: ${cmd.spec?.usage ?? "/think {level}"}`);
      return;
    }
    const level = (cmd.args[0] ?? "auto").toLowerCase();
    if (!isThinkLevel(level)) {
      ctx.error(`추론 레벨이 올바르지 않습니다. 사용법: ${cmd.spec?.usage ?? "/think {level}"}`);
      return;
    }
    ctx.setThink(level);
  },
};

/** runServerCommand executes a known server command and reports whether it was handled. */
export function runServerCommand(cmd: ParsedSlashCommand, ctx: ServerCommandContext): boolean {
  if (cmd.spec?.target !== "server") return false;
  const handler = handlers[cmd.name];
  if (!handler) {
    ctx.error(`/${cmd.name} 명령이 아직 구현되지 않았습니다.`);
    return true;
  }
  handler(ctx, cmd);
  return true;
}
