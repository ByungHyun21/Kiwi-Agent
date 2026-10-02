import { describe, expect, test } from "bun:test";
import {
  activitySummary,
  dagLayers,
  dagRenderFrame,
  fit,
  fitTail,
  NODE_ICONS,
  strWidth,
  type DagEdge,
  type DagNode,
} from "../src/tui/dag";

const n = (id: string, state: DagNode["state"] = "pending", label = id): DagNode => ({ id, label, state });

describe("strWidth", () => {
  test("hangul counts 2 per char", () => {
    expect(strWidth("한글")).toBe(4);
  });
  test("ascii counts 1 per char", () => {
    expect(strWidth("ab")).toBe(2);
  });
  test("emoji counts 2", () => {
    expect(strWidth("😀")).toBe(2);
  });
  test("empty", () => {
    expect(strWidth("")).toBe(0);
  });
});

describe("fit", () => {
  test("clips with ellipsis", () => {
    const out = fit("hello world", 8);
    expect(strWidth(out)).toBe(8);
    expect(out.endsWith("…")).toBe(true);
  });
  test("no clip when fits", () => {
    expect(fit("hi", 10)).toBe("hi");
  });
  test("fitTail keeps tail", () => {
    const out = fitTail("hello world", 8);
    expect(strWidth(out)).toBe(8);
    expect(out.startsWith("…")).toBe(true);
  });
  test("wide chars clip correctly", () => {
    const out = fit("한글한글한글", 7);
    expect(strWidth(out)).toBeLessThanOrEqual(7);
  });
});

describe("NODE_ICONS", () => {
  test("all states covered", () => {
    for (const s of ["pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"] as const) {
      expect(NODE_ICONS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("dagLayers", () => {
  test("linear plus parallel", () => {
    const nodes = [n("A"), n("B"), n("C"), n("D")];
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "D" },
      { from: "B", to: "C" },
      { from: "D", to: "C" },
    ];
    expect(dagLayers(nodes, edges)).toEqual([["A"], ["B", "D"], ["C"]]);
  });
  test("throws on cycle", () => {
    const nodes = [n("A"), n("B")];
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ];
    expect(() => dagLayers(nodes, edges)).toThrow();
  });
  test("empty", () => {
    expect(dagLayers([], [])).toEqual([]);
  });
});

describe("dagRenderFrame", () => {
  test("connectors and labels within width", () => {
    const nodes = [n("A", "running"), n("B", "pending")];
    const edges: DagEdge[] = [{ from: "A", to: "B" }];
    const lines = dagRenderFrame(40, nodes, edges);
    const all = lines.join("\n");
    expect(all).toContain("A");
    expect(all).toContain("B");
    expect(all).toMatch(/[│└┌]/);
    for (const l of lines) expect(strWidth(l)).toBeLessThanOrEqual(40);
  });
  test("empty nodes gives placeholder", () => {
    expect(dagRenderFrame(40, [], [])).toEqual([""]);
  });
  test("selected node highlighted", () => {
    const nodes = [n("A"), n("B")];
    const edges: DagEdge[] = [{ from: "A", to: "B" }];
    const lines = dagRenderFrame(40, nodes, edges, { selectedId: "A" });
    expect(lines.join("\n")).toContain("▐");
  });
});

describe("activitySummary", () => {
  const now = 100000;
  test("text phase stalls at 31s idle", () => {
    const a = { phase: "text" as const, sinceMs: now - 40000, lastAtMs: now - 31000 };
    const r = activitySummary(a, now);
    expect(r.stalled).toBe(true);
    expect(r.head.startsWith("⚠ 정지 의심")).toBe(true);
  });
  test("text phase not stalled at 29s idle", () => {
    const a = { phase: "text" as const, sinceMs: now - 40000, lastAtMs: now - 29000 };
    expect(activitySummary(a, now).stalled).toBe(false);
  });
  test("waiting stalls at 91s span", () => {
    const a = { phase: "waiting" as const, sinceMs: now - 91000, lastAtMs: now - 1000 };
    const r = activitySummary(a, now);
    expect(r.stalled).toBe(true);
    expect(r.head).toContain("대기 91초");
  });
  test("tool phase head includes tool name and seconds", () => {
    const a = { phase: "tool" as const, sinceMs: now - 12000, lastAtMs: now, tool: "bun test" };
    expect(activitySummary(a, now).head).toBe("▶ bun test · 12초");
  });
});
