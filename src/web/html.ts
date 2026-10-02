// Server-rendered web UI pages as typed template functions (port of the
// templ templates).

import type { Machine, Project, SessionInfo } from "../protocol.ts";

/** UIMessage is one rendered history entry of a session. */
export interface UIMessage {
  role: string;
  content: string;
  tools: string;
}

/** esc escapes text for safe HTML interpolation. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function navItem(href: string, label: string, key: string, active: string): string {
  const cls = "nav-item" + (active === key ? " is-active" : "");
  return `<a href="${esc(href)}" class="${cls}">${esc(label)}</a>`;
}

export function emptyState(title: string, hint: string): string {
  let h = "";
  if (hint !== "") h = `<p class="empty-hint">${esc(hint)}</p>`;
  return `<div class="empty">
    <div class="empty-mark"></div>
    <p class="empty-title">${esc(title)}</p>
    ${h}
  </div>`;
}

function statCard(label: string, value: string): string {
  return `<div class="stat">
    <span class="stat-value">${esc(value)}</span>
    <span class="stat-label">${esc(label)}</span>
  </div>`;
}

export function layout(title: string, active: string, children: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)} · Kiwi Server</title>
  <link rel="stylesheet" href="/static/style.css"/>
  <script src="/static/htmx.min.js"></script>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-name">KIWI</span>
        <span class="brand-sub">server</span>
      </div>
      <nav class="nav" hx-boost="true">
        ${navItem("/", "대시보드", "dashboard", active)}
        ${navItem("/machines", "기기", "machines", active)}
        ${navItem("/projects", "프로젝트", "projects", active)}
        ${navItem("/settings", "설정", "settings", active)}
        ${navItem("/docs", "자료", "docs", active)}
      </nav>
      <div class="sidebar-foot">
        <span class="dot"></span> 실행 중 · 로컬망
      </div>
    </aside>
    <main class="content">
      ${children}
    </main>
  </div>
</body>
</html>`;
}

export function dashboardPage(): string {
  return layout(
    "대시보드",
    "dashboard",
    `<header class="page-head">
      <h1>대시보드</h1>
      <p class="page-desc">서버와 작업 기기, 세션 상태를 한눈에 확인합니다.</p>
    </header>
    <section class="stats">
      ${statCard("등록된 기기", "0")}
      ${statCard("활성 세션", "0")}
      ${statCard("색인된 문서", "0")}
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>기기 상태</h2>
        <a class="link" href="/machines">기기 관리 →</a>
      </div>
      ${emptyState("등록된 기기가 없습니다", "기기 페이지에서 SSH로 접속할 작업 PC를 등록하세요.")}
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>최근 세션</h2>
      </div>
      ${emptyState("세션이 없습니다", "kiwi 에이전트에서 /project 로 프로젝트를 열면 세션이 생성됩니다.")}
    </section>`,
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "user": return "사용자";
    case "assistant": return "응답";
    case "tool": return "도구 결과";
    case "system": return "시스템";
    default: return role;
  }
}

export function fmtTime(t: Date | undefined): string {
  if (!t || Number.isNaN(t.getTime()) || t.getTime() === 0) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

export function projectsListPage(projects: Project[]): string {
  let body: string;
  if (projects.length === 0) {
    body = emptyState("등록된 프로젝트가 없습니다", "kiwi 에이전트에서 /project 로 만들거나 API 로 등록하세요.");
  } else {
    const rows = projects
      .map(
        (p) => `<tr>
          <td><a class="link" href="/projects/${p.id}">${esc(p.name)}</a></td>
          <td>${esc(p.machine)}</td>
          <td class="mono">${esc(p.workdir)}</td>
        </tr>`,
      )
      .join("\n");
    body = `<table class="table">
      <thead>
        <tr>
          <th>이름</th>
          <th>기기</th>
          <th>작업 폴더</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  return layout(
    "프로젝트",
    "projects",
    `<header class="page-head">
      <h1>프로젝트</h1>
      <p class="page-desc">등록된 프로젝트(작업 폴더)와 세션을 탐색합니다.</p>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>프로젝트 목록</h2>
      </div>
      ${body}
    </section>`,
  );
}

export function projectDetailPage(p: Project, sessions: SessionInfo[]): string {
  let body: string;
  if (sessions.length === 0) {
    body = emptyState("세션이 없습니다", "kiwi 에이전트에서 이 프로젝트를 열고 대화를 시작하면 세션이 생성됩니다.");
  } else {
    const rows = sessions
      .map(
        (s) => `<tr>
          <td><a class="link" href="/sessions/${esc(s.id)}">${esc(s.name)}</a></td>
          <td>${fmtTime(s.updatedAt)}</td>
        </tr>`,
      )
      .join("\n");
    body = `<table class="table">
      <thead>
        <tr>
          <th>이름</th>
          <th>갱신</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  return layout(
    p.name,
    "projects",
    `<header class="page-head">
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="page-desc"><span class="mono">${esc(p.workdir)}</span> · 기기 ${esc(p.machine)}</p>
      </div>
      <a class="link" href="/projects">← 프로젝트 목록</a>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>세션</h2>
      </div>
      ${body}
    </section>`,
  );
}

export function sessionDetailPage(projectName: string, s: SessionInfo, msgs: UIMessage[]): string {
  let body: string;
  if (msgs.length === 0) {
    body = emptyState("메시지가 없습니다", "");
  } else {
    const rows = msgs
      .map((m) => {
        const tools = m.tools !== "" ? `<pre class="msg-tools">${esc(m.tools)}</pre>` : "";
        return `<div class="msg msg-${esc(m.role)}">
          <span class="msg-role">${esc(roleLabel(m.role))}</span>
          ${tools}
          <pre class="msg-content">${esc(m.content)}</pre>
        </div>`;
      })
      .join("\n");
    body = `<div class="msgs">${rows}</div>`;
  }
  return layout(
    s.name + " 세션",
    "projects",
    `<header class="page-head">
      <div>
        <h1>${esc(s.name)}</h1>
        <p class="page-desc">프로젝트 ${esc(projectName)} · 갱신 ${fmtTime(s.updatedAt)}</p>
      </div>
      <a class="link" href="/projects">← 프로젝트 목록</a>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>대화 기록</h2>
      </div>
      ${body}
    </section>`,
  );
}

function machineRow(m: Machine): string {
  const chip =
    m.state === "connected"
      ? `<span class="chip chip-ok">${esc(m.state)}</span>`
      : m.state === "disconnected"
        ? `<span class="chip chip-bad">${esc(m.state)}</span>`
        : `<span class="chip">${esc(m.state)}</span>`;
  const seen = m.lastSeen ? fmtTime(m.lastSeen) : "—";
  return `<tr>
    <td>${esc(m.name)}</td>
    <td class="mono">${esc(m.user + "@" + m.host)}</td>
    <td>${chip}</td>
    <td>${seen}</td>
  </tr>`;
}

export function machinesPage(machines: Machine[]): string {
  let body: string;
  if (machines.length === 0) {
    body = emptyState("등록된 기기가 없습니다", "API POST /api/machines 또는 kiwi /server 메뉴로 등록하세요.");
  } else {
    const rows = machines.map(machineRow).join("\n");
    body = `<table class="table">
      <thead>
        <tr>
          <th>이름</th>
          <th>호스트</th>
          <th>상태</th>
          <th>마지막 확인</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  return layout(
    "기기",
    "machines",
    `<header class="page-head">
      <div>
        <h1>기기</h1>
        <p class="page-desc">SSH로 접속해 실제 작업(파일·셸)이 실행되는 원격 PC를 등록합니다.</p>
      </div>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>등록된 기기</h2>
      </div>
      ${body}
    </section>`,
  );
}

export function settingsPage(token: string, provider: string, baseURL: string, model: string): string {
  return layout(
    "설정",
    "settings",
    `<header class="page-head">
      <h1>설정</h1>
      <p class="page-desc">모델 공급자·역할 라우팅·접근 토큰. agent 에서도 수정하면 서버로 동기화됩니다.</p>
    </header>

    <section class="panel">
      <div class="panel-head">
        <h2>모델 공급자</h2>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>이름</th>
            <th>엔드포인트</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${esc(provider)}</td>
            <td class="mono">${esc(baseURL)}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>역할 라우팅</h2>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>역할</th>
            <th>공급자</th>
            <th>모델</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>agent 채팅</td>
            <td>${esc(provider)}</td>
            <td class="mono">${esc(model)}</td>
          </tr>
        </tbody>
      </table>
      <p class="panel-note">변경은 API PUT /api/roles/agent-chat 으로 수행합니다.</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>접근 토큰</h2>
      </div>
      <div class="token-field">
        <span class="token-value mono">${esc(token)}</span>
      </div>
      <p class="panel-note">kiwi 에이전트 첫 실행 시 서버 주소와 함께 이 토큰을 입력합니다.</p>
    </section>`,
  );
}

export function chatPage(defaultToken: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>채팅 · Kiwi Server</title>
  <style>
    body { margin:0; background:#141613; color:#e8eadf; font:14px/1.5 system-ui,sans-serif; display:flex; flex-direction:column; height:100vh; }
    header { padding:10px 16px; border-bottom:1px solid #2a2d28; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    header b { color:#8fce5a; letter-spacing:2px; }
    #status { font-size:12px; color:#b9b39f; }
    #state { font-size:12px; color:#7d8377; margin-left:auto; text-align:right; }
    #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:6px; }
    .u { align-self:flex-end; background:#2a3324; padding:6px 12px; border-radius:12px 12px 2px 12px; max-width:70%; white-space:pre-wrap; }
    .a { align-self:flex-start; background:#1e201c; padding:6px 12px; border-radius:12px 12px 12px 2px; max-width:70%; white-space:pre-wrap; }
    .r { align-self:flex-start; color:#7d8377; font-size:12px; max-width:70%; white-space:pre-wrap; }
    .t { align-self:flex-start; color:#a8c17a; font-size:12px; max-width:95%; white-space:pre-wrap; border-left:2px solid #4a5240; padding-left:8px; }
    .e { color:#e07a5f; }
    form { display:flex; gap:8px; padding:12px 16px; border-top:1px solid #2a2d28; }
    input[type=text] { flex:1; background:#1e201c; border:1px solid #2a2d28; color:#e8eadf; border-radius:8px; padding:8px 12px; font:inherit; }
    button { background:#8fce5a; color:#141613; border:0; border-radius:8px; padding:8px 14px; font:inherit; font-weight:600; cursor:pointer; }
    button.ghost { background:#2a2d28; color:#e8eadf; }
    select { background:#1e201c; color:#e8eadf; border:1px solid #2a2d28; border-radius:6px; padding:4px; }
  </style>
</head>
<body>
  <header>
    <b>KIWI</b> 채팅
    <select id="project"></select>
    <button class="ghost" id="newSession" type="button">새 세션</button>
    <button class="ghost" id="stopBtn" type="button">정지</button>
    <span id="status">연결 중…</span>
    <span id="state"></span>
  </header>
  <div id="log"></div>
  <form id="f"><input type="text" id="msg" placeholder="메시지 입력" autocomplete="off"/><button>전송</button></form>
  <script>
    const q = new URLSearchParams(location.search);
    const token = q.get("token") || localStorage.getItem("kiwi-token") || " + esc(defaultToken) + ";
    localStorage.setItem("kiwi-token", token);
    const log = document.getElementById("log");
    const statusEl = document.getElementById("status");
    const stateEl = document.getElementById("state");
    const projectSel = document.getElementById("project");
    let ws = null, busy = false, streamLine = null;

    function line(cls, text) {
      const d = document.createElement("div");
      d.className = cls; d.textContent = text;
      log.appendChild(d); log.scrollTop = log.scrollHeight;
      return d;
    }
    function append(kind, text) {
      if (!streamLine || streamLine.dataset.k !== kind) { streamLine = line(kind, ""); streamLine.dataset.k = kind; }
      streamLine.textContent += text;
      log.scrollTop = log.scrollHeight;
    }
    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(proto + "://" + location.host + "/ws?token=" + encodeURIComponent(token));
      ws.onopen = () => { statusEl.textContent = "연결됨"; };
      ws.onclose = () => { statusEl.textContent = "끊김 — 재접속"; setTimeout(connect, 2000); };
      ws.onerror = () => { statusEl.textContent = "연결 오류 (토큰 확인)"; };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        switch (ev.type) {
          case "hello": loadProjects(); break;
          case "delta": append("a", ev.text); break;
          case "reasoning": append("r", ev.text); break;
          case "tool_call": streamLine = null; line("t", "⚒ " + ev.name + " " + (ev.args || "").slice(0, 120)); break;
          case "tool_result": line("t", ev.result || ""); break;
          case "status": busy = ev.name === "working"; statusEl.textContent = ev.name || ""; if (ev.name === "idle") streamLine = null; break;
          case "state": stateEl.textContent = (ev.state?.project || "") + " · " + (ev.state?.machine || "") + " · " + (ev.state?.model || "") + " · ctx " + (ev.state?.ctxUsed || 0) + "/" + (ev.state?.ctxMax || 0); break;
          case "history": log.innerHTML = ""; streamLine = null; (ev.history || []).forEach(h => line(h.kind === "user" ? "u" : h.kind === "tool" || h.kind === "result" ? "t" : h.kind === "notice" ? "r" : "a", h.text)); break;
          case "error": line("e", ev.error || ""); break;
        }
      };
    }
    async function loadProjects() {
      try {
        const res = await fetch("/api/projects", { headers: { Authorization: "Bearer " + token } });
        const projects = await res.json();
        projectSel.innerHTML = "";
        for (const p of projects) {
          const o = document.createElement("option");
          o.value = p.name; o.textContent = p.name;
          projectSel.appendChild(o);
        }
      } catch {}
    }
    projectSel.onchange = () => ws && ws.send(JSON.stringify({ type: "project", text: projectSel.value }));
    document.getElementById("newSession").onclick = () => {
      streamLine = null;
      if (projectSel.value) ws.send(JSON.stringify({ type: "project", text: projectSel.value }));
      ws.send(JSON.stringify({ type: "new", text: "web" }));
    };
    document.getElementById("stopBtn").onclick = () => ws && ws.send(JSON.stringify({ type: "stop" }));
    document.getElementById("f").onsubmit = (e) => {
      e.preventDefault();
      const input = document.getElementById("msg");
      const text = input.value.trim();
      if (!text || !ws) return;
      line("u", text);
      ws.send(JSON.stringify({ type: "send", text }));
      input.value = "";
      streamLine = null;
    };
    connect();
  </script>
</body>
</html>`;
}
export function docsPage(): string {
  return layout(
    "자료",
    "docs",
    `<header class="page-head">
      <h1>자료</h1>
      <p class="page-desc">데이터시트·문서를 업로드하면 파싱·색인되어 agent 에서 검색할 수 있습니다.</p>
    </header>

    <section class="panel">
      <div class="dropzone">
        <p class="dropzone-title">PDF · 문서를 이 영역에 끌어다 놓기</p>
        <p class="dropzone-hint">또는</p>
        <button class="btn" type="button">파일 선택</button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>문서 목록</h2>
        <input class="input search" type="search" placeholder="자료 검색…"/>
      </div>
      ${emptyState("문서가 없습니다", "업로드된 자료는 원본과 함께 색인되어 검색 가능해집니다.")}
    </section>`,
  );
}
