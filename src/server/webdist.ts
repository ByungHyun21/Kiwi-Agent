// Serves the built web SPA (web/dist) from kiwi-server with SPA fallback.
import * as path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

/** serveWebDist resolves one GET path inside a built SPA directory.
 *  Existing files are served as-is; unknown extension-less routes fall
 *  back to index.html (SPA client routing). Returns null when the dist
 *  directory itself is missing so the caller can use legacy pages. */
export async function serveWebDist(dist: string, reqPath: string): Promise<Response | null> {
  if (!(await Bun.file(path.join(dist, "index.html")).exists())) return null;
  const clean = reqPath.split("?")[0]!;
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(path.normalize(dist))) return new Response("forbidden", { status: 403 });

  const asset = Bun.file(file);
  if (await asset.exists()) {
    return new Response(asset, { headers: { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" } });
  }
  if (!path.extname(rel)) {
    const index = Bun.file(path.join(dist, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  }
  return new Response("not found", { status: 404 });
}
