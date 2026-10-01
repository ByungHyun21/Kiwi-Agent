// HTML page handlers backed by the store and web templates.

import { projectDetailPage, projectsListPage, sessionDetailPage, type UIMessage } from "../web/html.ts";
import type { KiwiServer } from "./server.ts";

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function projectsPage(s: KiwiServer): Response {
  return html(projectsListPage(s.store.projects()));
}

export function projectDetail(s: KiwiServer, idRaw: string): Response {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response("not found", { status: 404 });
  }
  let p;
  try {
    p = s.store.project(id);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const sessions = s.store.sessions(id);
  return html(projectDetailPage(p, sessions));
}

export function sessionDetail(s: KiwiServer, id: string): Response {
  let sess;
  try {
    sess = s.store.session(id);
  } catch {
    return new Response("not found", { status: 404 });
  }
  let projectName = "";
  try {
    projectName = s.store.project(sess.projectId).name;
  } catch {
    // ignore
  }
  const sessions = s.store.sessions(sess.projectId);

  const info = { id: sess.id, name: sess.name, updatedAt: sess.updatedAt as Date | undefined };
  for (const si of sessions) {
    if (si.id === sess.id) {
      info.name = si.name;
      info.updatedAt = si.updatedAt;
    }
  }

  const msgs = s.store.messages(id);
  return html(sessionDetailPage(projectName, { ...info, updatedAt: info.updatedAt }, toUIMessages(msgs)));
}

export function toUIMessages(msgs: { role: string; content: string; toolCalls?: { name: string; args: string }[] }[]): UIMessage[] {
  return msgs.map((m) => {
    const tools = (m.toolCalls ?? []).map((tc) => tc.name + " " + tc.args).join("\n");
    return { role: m.role, content: m.content, tools };
  });
}
