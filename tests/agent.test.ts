// Agent core tests: diff, path safety.

import { describe, expect, test } from "bun:test";
import { lcsDiff, safePath, unifiedDiff } from "../src/agent.ts";

describe("safePath", () => {
  test("accepts relative paths", () => {
    expect(safePath("index.html")).toBe(true);
    expect(safePath("a/b/c.txt")).toBe(true);
    expect(safePath("./x")).toBe(true);
  });
  test("rejects absolute and traversal paths", () => {
    expect(safePath("")).toBe(false);
    expect(safePath("/etc/passwd")).toBe(false);
    expect(safePath("..")).toBe(false);
    expect(safePath("../outside")).toBe(false);
    expect(safePath("a/../../b")).toBe(false);
  });
});

describe("unifiedDiff", () => {
  test("new file shows full content as additions", () => {
    const d = unifiedDiff("hello.txt", "", "a\nb\n");
    expect(d).toContain("--- hello.txt");
    expect(d).toContain("+++ hello.txt");
    expect(d).toContain("+ a");
    expect(d).toContain("+ b");
    // deletions only carry the empty sentinel line (matches the Go original)
    expect(d.split("\n").filter((ln) => ln.startsWith("- ")).every((ln) => ln === "- ")).toBe(true);
  });

  test("change shows mixed +/- lines", () => {
    const d = unifiedDiff("f.txt", "a\nb\nc", "a\nx\nc");
    expect(d).toContain("- b");
    expect(d).toContain("+ x");
    expect(d).not.toContain("+ a");
    expect(d).not.toContain("- a");
  });

  test("no change", () => {
    expect(unifiedDiff("f.txt", "same", "same\n")).toContain("변경 없음");
  });
});

describe("lcsDiff", () => {
  test("basic ops", () => {
    const ops = lcsDiff(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops).toEqual([
      { op: "-", text: "b" },
      { op: "+", text: "x" },
    ]);
  });
  test("pure insert", () => {
    const ops = lcsDiff(["a"], ["a", "b"]);
    expect(ops).toEqual([{ op: "+", text: "b" }]);
  });
  test("pure delete", () => {
    const ops = lcsDiff(["a", "b"], []);
    expect(ops).toEqual([{ op: "-", text: "a" }, { op: "-", text: "b" }]);
  });
});
