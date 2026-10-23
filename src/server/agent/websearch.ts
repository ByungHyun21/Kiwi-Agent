// Server-side web search backed by SearXNG. Unlike file tools this runs on the
// kiwi-server host; the URL is configured in the admin panel (or SEARXNG_URL).

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxResponse {
  results?: SearxResult[];
  answers?: string[];
  suggestions?: string[];
}

/** searchWeb queries SearXNG and renders compact numbered results. */
export async function searchWeb(baseURL: string, query: string, limit: number, signal?: AbortSignal): Promise<string> {
  if (baseURL.trim() === "") {
    return "오류: 웹 검색이 설정되지 않았습니다. 관리 → 검색엔진에서 SearXNG 주소를 입력하세요.";
  }
  const url = searchEndpoint(baseURL, query);
  const timeout = AbortSignal.timeout(15_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Accept: "application/json" }, signal: sig });
  } catch (err) {
    if (signal?.aborted) throw err;
    return "오류: SearXNG에 연결할 수 없습니다: " + (err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) {
    if (resp.status === 403) {
      return "오류 (403): SearXNG JSON API가 비활성화되어 있습니다 (search.formats에 json 필요).";
    }
    return `오류 (${resp.status}): SearXNG 검색 실패`;
  }
  let data: SearxResponse;
  try {
    data = (await resp.json()) as SearxResponse;
  } catch {
    return "오류: SearXNG 응답을 해석할 수 없습니다.";
  }
  return formatResults(data, limit);
}

/** probeSearxng checks that a base URL speaks the SearXNG JSON API. */
export async function probeSearxng(baseURL: string): Promise<{ ok: boolean; message: string; results?: number }> {
  if (baseURL.trim() === "") return { ok: false, message: "SearXNG 주소가 설정되지 않았습니다" };
  const timeout = AbortSignal.timeout(10_000);
  let resp: Response;
  try {
    resp = await fetch(searchEndpoint(baseURL, "kiwi connection test"), {
      headers: { Accept: "application/json" },
      signal: timeout,
    });
  } catch (err) {
    return { ok: false, message: "연결할 수 없습니다: " + (err instanceof Error ? err.message : String(err)) };
  }
  if (!resp.ok) {
    if (resp.status === 403) {
      return { ok: false, message: "JSON API가 비활성화되어 있습니다 (search.formats에 json 필요)" };
    }
    return { ok: false, message: `SearXNG가 HTTP ${resp.status}로 응답했습니다` };
  }
  try {
    const data = (await resp.json()) as SearxResponse;
    const count = Array.isArray(data.results) ? data.results.length : 0;
    return { ok: true, message: `연결됨 (결과 ${count}개)`, results: count };
  } catch {
    return { ok: false, message: "JSON 응답을 해석할 수 없습니다" };
  }
}

function searchEndpoint(baseURL: string, query: string): URL {
  const url = new URL("search", baseURL.endsWith("/") ? baseURL : baseURL + "/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  return url;
}

/** formatResults renders the subset of the SearXNG JSON response the model sees. */
export function formatResults(data: SearxResponse, limit: number): string {
  const results = (data.results ?? []).slice(0, Math.max(1, limit));
  const blocks: string[] = [];
  const answers = (data.answers ?? []).slice(0, 3);
  if (answers.length > 0) blocks.push("답변: " + answers.join(" / "));
  results.forEach((r, i) => {
    const title = (r.title ?? "").replace(/\s+/g, " ").trim() || "(제목 없음)";
    const link = (r.url ?? "").trim();
    const snippet = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    const lines = [`${i + 1}. ${title}`];
    if (link !== "") lines.push(`   ${link}`);
    if (snippet !== "") lines.push(`   ${snippet}`);
    blocks.push(lines.join("\n"));
  });
  if (blocks.length === 0) {
    const suggestions = (data.suggestions ?? []).slice(0, 5);
    return suggestions.length > 0 ? "(검색 결과 없음) 제안: " + suggestions.join(", ") : "(검색 결과 없음)";
  }
  return blocks.join("\n");
}
