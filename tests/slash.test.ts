// Shared slash-command parser and hint tests.

import { describe, expect, test } from "bun:test";
import { parseSlashCommand, slashHint } from "../src/shared/slash.ts";

describe("slash commands", () => {
  test("parses known commands and arguments", () => {
    const cmd = parseSlashCommand("/think max");
    expect(cmd?.name).toBe("think");
    expect(cmd?.args).toEqual(["max"]);
    expect(cmd?.spec?.target).toBe("server");

    expect(parseSlashCommand("/think")?.args).toEqual([]);
    expect(parseSlashCommand("/think")?.spec?.runWhileBusy).toBe(true);
    expect(parseSlashCommand("/model")?.spec?.target).toBe("client");
    expect(parseSlashCommand("/new")?.spec?.runWhileBusy).toBeUndefined();
  });

  test("does not treat paths as commands", () => {
    expect(parseSlashCommand("/home/yoon/project")).toBeNull();
    expect(parseSlashCommand("/foo/bar")).toBeNull();
  });

  test("shows argument hints and unique completions", () => {
    expect(slashHint("/think")?.text).toBe(" on | off | low | medium | high | xhigh | max");
    expect(slashHint("/think ")?.text).toBe(" on | off | low | medium | high | xhigh | max");
    expect(slashHint("/think me")?.text).toBe("dium");
    expect(slashHint("/think m")).toBeNull();
    expect(slashHint("/model")).toBeNull();
  });
});
