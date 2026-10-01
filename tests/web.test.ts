// Web UI tests: escaping and page structure.

import { describe, expect, test } from "bun:test";
import { dashboardPage, esc, projectsListPage, sessionDetailPage } from "../src/web/html.ts";

describe("web html", () => {
  test("esc escapes HTML specials", () => {
    expect(esc(`<script>x</script>`)).toBe("&lt;script&gt;x&lt;/script&gt;");
    expect(esc(`a"b'c&d`)).toBe("a&quot;b&#39;c&amp;d");
  });

  test("dashboard renders layout and nav", () => {
    const html = dashboardPage();
    expect(html).toContain("대시보드");
    expect(html).toContain('href="/projects"');
    expect(html).toContain("/static/style.css");
  });

  test("project names are escaped", () => {
    const html = projectsListPage([{ id: 1, name: "<img src=x onerror=alert(1)>", machine: "m", workdir: "/w" }]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("session transcript page escapes message content", () => {
    const html = sessionDetailPage("p", { id: "s", name: "세션", updatedAt: new Date() }, [
      { role: "user", content: "<b>굵게</b>", tools: "" },
    ]);
    expect(html).not.toContain("<b>굵게</b>");
    expect(html).toContain("&lt;b&gt;굵게&lt;/b&gt;");
  });
});
