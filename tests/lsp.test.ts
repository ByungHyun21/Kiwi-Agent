import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameReader, fromLspPos, langForFile, toLspPos } from "../src/lspbroker.ts";

describe("lsp positions", () => {
  test("1-based to 0-based and back", () => {
    expect(toLspPos(1, 1)).toEqual({ line: 0, character: 0 });
    expect(toLspPos(12, 34)).toEqual({ line: 11, character: 33 });
    expect(fromLspPos({ line: 0, character: 0 })).toEqual({ line: 1, character: 1 });
    expect(fromLspPos(toLspPos(7, 9))).toEqual({ line: 7, character: 9 });
  });
});

describe("langForFile", () => {
  test("maps extensions to languages", () => {
    expect(langForFile("a.ts")).toBe("typescript");
    expect(langForFile("a.tsx")).toBe("typescript");
    expect(langForFile("a.mjs")).toBe("javascript");
    expect(langForFile("a.py")).toBe("python");
    expect(langForFile("a.go")).toBe("go");
    expect(langForFile("a.rs")).toBe("rust");
    expect(langForFile("a.c")).toBe("c");
    expect(langForFile("a.cpp")).toBe("cpp");
    expect(langForFile("a.hpp")).toBe("cpp");
    expect(langForFile("a.cs")).toBe("csharp");
    expect(langForFile("A.java")).toBe("java");
    expect(langForFile("a.xyz")).toBe("xyz");
  });
});

describe("json-rpc framing", () => {
  test("encodeFrame roundtrips through FrameReader", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: "한글" } };
    const buf = encodeFrame(msg);
    expect(buf.subarray(0, 16).toString("ascii")).toStartWith("Content-Length:");
    const r = new FrameReader();
    r.push(Buffer.from(buf.subarray(0, 20)));
    expect(r.next()).toBeNull();
    r.push(Buffer.from(buf.subarray(20)));
    expect(r.next()).toEqual(msg);
    expect(r.next()).toBeNull();
  });

  test("FrameReader handles two frames in one chunk", () => {
    const a = encodeFrame({ id: 1, result: [1, 2] });
    const b = encodeFrame({ method: "x", params: {} });
    const r = new FrameReader();
    r.push(Buffer.concat([a, b]));
    expect(r.next()).toEqual({ id: 1, result: [1, 2] });
    expect(r.next()).toEqual({ method: "x", params: {} });
  });
});
