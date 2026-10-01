// TUI logic smoke tests (headless port of app_test.go's spirit): model +
// update + view without a live terminal.

import { describe, expect, test } from "bun:test";
import { newModel } from "../src/tui/model.ts";
import { update } from "../src/tui/update.ts";
import { view } from "../src/tui/view.ts";
import { applyEvent, totalWrapped } from "../src/tui/transcript.ts";
import { candidates } from "../src/tui/commands.ts";
import type { KeyMsg } from "../src/tui/term.ts";

function key(type: string, runes: string[] = [], str?: string): KeyMsg {
  return { t: "key", type, runes, str: str ?? type };
}

function type(m: ReturnType<typeof newModel>, s: string): void {
  for (const r of Array.from(s)) update(m, key("runes", [r], r));
}

describe("tui model", () => {
  test("resize sets geometry and input width", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    expect(m.width).toBe(120);
    expect(m.height).toBe(30);
    expect(m.msgIn.width).toBeGreaterThan(10);
  });

  test("streamed deltas land in the transcript and render", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    applyEvent(m, { type: "delta", text: "안녕하세요 " });
    applyEvent(m, { type: "delta", text: "키위입니다" });
    expect(m.transcript).toHaveLength(1); // same-kind lines merge
    expect(m.transcript[0]!.text).toBe("안녕하세요 키위입니다");
    const v = view(m);
    expect(v).toContain("KIWI");
    expect(v).toContain("키위입니다");
  });

  test("tool args stream then tool call adds nothing twice", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    applyEvent(m, { type: "tool_args", name: "write_file", text: '{"path"' });
    applyEvent(m, { type: "tool_args", name: "write_file", text: ':"a.txt"}' });
    applyEvent(m, { type: "tool_call", name: "write_file", args: '{"path":"a.txt"}' });
    expect(m.transcript).toHaveLength(1);
    expect(m.transcript[0]!.text).toContain("write_file");
    applyEvent(m, { type: "tool_result", name: "write_file", result: "sha" });
    expect(m.transcript).toHaveLength(2);
    expect(m.curTool).toBe("");
  });

  test("status working/idle toggles busy and spinner", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    applyEvent(m, { type: "status", name: "working" });
    expect(m.busy).toBe(true);
    const cmds = update(m, { t: "tick" });
    expect(cmds.length).toBe(1); // keeps ticking
    applyEvent(m, { type: "status", name: "idle" });
    expect(m.busy).toBe(false);
    expect(update(m, { t: "tick" })).toHaveLength(0);
  });

  test("history replaces the transcript", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    applyEvent(m, { type: "delta", text: "이전" });
    applyEvent(m, {
      type: "history",
      history: [
        { kind: "user", text: "질문" },
        { kind: "assistant", text: "응답" },
      ],
    });
    expect(m.transcript).toHaveLength(2);
    expect(m.scroll).toBe(-1);
  });

  test("state events update the sidebar", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    applyEvent(m, {
      type: "state",
      session: "s1",
      state: { project: "demo", machine: "box", model: "qwen", goal: "g", ctxUsed: 50, ctxMax: 100, tokens: 42 },
    });
    expect(m.currentSession).toBe("s1");
    expect(m.project).toBe("demo");
    expect(m.machine).toBe("box");
    expect(m.tokens).toBe(42);
    const v = view(m);
    expect(v).toContain("demo");
  });

  test("typing builds input and popup candidates", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    type(m, "/pro");
    expect(m.msgIn.getValue()).toBe("/pro");
    const items = candidates(m);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.name).toBe("/project");
    const v = view(m);
    expect(v).toContain("/project");
  });

  test("esc clears input (surface behavior)", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    type(m, "hello");
    update(m, key("esc"));
    expect(m.msgIn.getValue()).toBe("");
  });

  test("plain text entered without connection shows an error line", () => {
    const m = newModel();
    update(m, { t: "resize", width: 120, height: 30 });
    type(m, "파일 만들어줘");
    update(m, key("enter"));
    expect(m.transcript.some((l) => l.text.includes("서버에 연결되어 있지 않습니다"))).toBe(true);
  });

  test("totalWrapped appends a blank separator per entry", () => {
    const m = newModel();
    applyEvent(m, { type: "delta", text: "a" });
    applyEvent(m, { type: "delta", text: "b" });
    // streamKind merges same-kind lines, so force distinct entries
    applyEvent(m, { type: "tool_result", name: "t", result: "r" });
    const lines = totalWrapped(m, 40);
    expect(lines.filter((l) => l === "").length).toBeGreaterThanOrEqual(2);
  });
});
