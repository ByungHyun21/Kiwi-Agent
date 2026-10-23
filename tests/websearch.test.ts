// Web search wiring: the agent tool calls the SearXNG JSON API on the server.

import { afterAll, describe, expect, test } from "bun:test";
import { READ_ONLY_TOOLS, agentTools } from "../src/server/agent/tools.ts";
import { formatResults, probeSearxng, searchWeb } from "../src/server/agent/websearch.ts";

let seen: URL | null = null;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    seen = url;
    if (url.pathname === "/search" && url.searchParams.get("format") === "json") {
      return Response.json({
        results: [
          { title: "Kiwi docs", url: "https://example.test/kiwi", content: "A self-hosted\nagent." },
          { title: "Second", url: "https://example.test/second", content: "More detail." },
        ],
        answers: ["Kiwi is an agent."],
      });
    }
    if (url.pathname === "/forbidden/search") return new Response("nope", { status: 403 });
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("web_search", () => {
  test("is exposed as a read-only agent tool", () => {
    expect(agentTools.some((t) => t.name === "web_search")).toBe(true);
    expect(READ_ONLY_TOOLS.has("web_search")).toBe(true);
  });

  test("queries the SearXNG JSON API and renders results", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const out = await searchWeb(base, "kiwi agent", 5);
    expect(seen?.pathname).toBe("/search");
    expect(seen?.searchParams.get("q")).toBe("kiwi agent");
    expect(seen?.searchParams.get("format")).toBe("json");
    expect(out).toContain("답변: Kiwi is an agent.");
    expect(out).toContain("1. Kiwi docs");
    expect(out).toContain("https://example.test/kiwi");
    expect(out).toContain("A self-hosted agent.");
    expect(out).toContain("2. Second");
  });

  test("honors the result limit", () => {
    const out = formatResults(
      { results: [{ title: "a" }, { title: "b" }, { title: "c" }] },
      2,
    );
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
    expect(out).not.toContain("3. c");
  });

  test("reports an unconfigured search engine", async () => {
    expect(await searchWeb("", "q", 5)).toContain("검색엔진");
  });

  test("explains a disabled JSON API", async () => {
    const base = `http://127.0.0.1:${server.port}/forbidden`;
    expect(await searchWeb(base, "q", 5)).toContain("JSON API");
  });
});

describe("SearXNG probe", () => {
  test("reports a working JSON endpoint", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await probeSearxng(base)).toEqual({ ok: true, message: "연결됨 (결과 2개)", results: 2 });
  });

  test("explains a disabled JSON API", async () => {
    const base = `http://127.0.0.1:${server.port}/forbidden`;
    expect((await probeSearxng(base)).message).toContain("JSON API");
  });

  test("reports a missing URL", async () => {
    expect((await probeSearxng("")).ok).toBe(false);
  });
});
