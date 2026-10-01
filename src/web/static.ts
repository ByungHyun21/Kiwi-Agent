// Static web assets embedded at build time (CSS, vendored JS).
import styleCss from "./static/style.css" with { type: "text" };
import htmxJs from "./static/htmx.min.js" with { type: "text" };

export const assets: Record<string, { body: string; type: string }> = {
  "style.css": { body: styleCss, type: "text/css; charset=utf-8" },
  "htmx.min.js": { body: htmxJs, type: "text/javascript; charset=utf-8" },
};

/** serveStatic handles GET /static/<name>. */
export function serveStatic(name: string): Response | null {
  const asset = assets[name];
  if (!asset) return null;
  return new Response(asset.body, {
    headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=300" },
  });
}
