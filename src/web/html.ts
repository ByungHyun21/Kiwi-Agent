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
