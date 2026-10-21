// Phase 2 TUI: alt-screen full app on OpenTUI.
// Transcript lives in a sticky-bottom scrollbox; footer keeps status + composer.
// Events arrive over WS (protocol.ts) and project into Solid signals.
import { createCliRenderer, SyntaxStyle, type CliRenderer, type InputRenderable, type TextRenderable } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { WSClient, restURL } from "../tui/client.ts";
import { loadConfig, saveLang } from "../tui/config.ts";
import { translations, validLang, defaultLang, type Lang } from "../tui/lang.ts";
import {
  colorAmber,
  colorBadgeOff,
  colorBadgeOn,
  colorDeep,
  colorLabel,
  colorLine,
  colorNotice,
  colorReasoning,
  colorResult,
  colorError,
  colorSoft,
  colorTool,
  colorUser,
  rightPanelWidth,
} from "./theme.ts";
import {
  EvDelta,
  EvDone,
  EvError,
  EvHistory,
  EvSessions,
  EvState,
  EvStatus,
  EvToolArgs,
  EvToolCall,
  EvToolResult,
  MsgCompact,
  MsgNew,
  MsgProject,
  MsgResume,
  MsgSend,
  MsgSessions,
  MsgSetGoal,
  MsgStop,
  MsgState,
  type Event,
  type HistoryEntry,
  type Project,
  type SessionInfo,
} from "../protocol.ts";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LINES = 500;

// ---- transcript store ----
interface Block {
  id: number;
  kind: "text" | "md" | "reasoning";
  text: string;
  fg?: string;
}
const [blocks, setBlocks] = createSignal<Block[]>([]);
let nextBlockId = 1;

function addBlock(kind: Block["kind"], text: string, fg?: string): void {
  setBlocks((prev) => {
    const next = [...prev, { id: nextBlockId++, kind, text, fg }];
    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  });
}

function appendToBlock(text: string): void {
  setBlocks((prev) => {
    if (prev.length === 0) return prev;
    const copy = prev.slice();
    const last = copy[copy.length - 1]!;
    copy[copy.length - 1] = { ...last, text: last.text + text };
    return copy;
  });
}

/** upgrade the trailing streamed text block to rendered markdown */
function promoteLastToMarkdown(): void {
  setBlocks((prev) => {
    for (let i = prev.length - 1; i >= 0; i--) {
      const b = prev[i]!;
      if (b.kind === "reasoning") continue;
      if (b.kind === "text") {
        const copy = prev.slice();
        copy[i] = { ...b, kind: "md" };
        return copy;
      }
      return prev;
    }
    return prev;
  });
}

/** drop reasoning blocks — they served their purpose while streaming */
function dropReasoning(): void {
  setBlocks((prev) => prev.filter((b) => b.kind !== "reasoning"));
}

function addLine(text: string, fg = "#cccccc"): void {
  addBlock("text", text, fg);
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    let cur = "";
    for (const word of raw.split(" ")) {
      if (cur === "") cur = word;
      else if (cur.length + 1 + word.length <= width) cur += " " + word;
      else {
        out.push(cur);
        cur = word.length > width ? word.slice(0, width) : word;
      }
    }
    out.push(cur);
  }
  return out;
}

// ---- app state (signals) ----
const [conn, setConn] = createSignal<"connecting" | "ok" | "closed">("connecting");
const [busy, setBusy] = createSignal(false);
const [status, setStatus] = createSignal("");
const [panel, setPanel] = createSignal({ project: "", model: "", machine: "", ctxUsed: 0, ctxMax: 128000, tokens: 0, goal: "" });
const [session, setSession] = createSignal("");
const [lang, setLang] = createSignal<Lang>(defaultLang);
const [todos, setTodos] = createSignal<string[]>([]);
const [sessionList, setSessionList] = createSignal<SessionInfo[]>([]);
interface Dialog {
  title: string;
  options: { name: string; description: string; value: string }[];
  onPick: (value: string) => void;
}
const [dialog, setDialog] = createSignal<Dialog | null>(null);
let client: WSClient | null = null;
let renderer: CliRenderer | null = null;
let serverAddr = "";
let serverToken = "";

const t = () => translations[lang()];

// ---- transcript writes ----
let inAssistant = false;
let inReasoning = false;

function endStreamBlocks(): void {
  inAssistant = false;
  inReasoning = false;
}

function addStream(kind: "assistant" | "reasoning", text: string): void {
  const fg = kind === "assistant" ? undefined : colorReasoning;
  if (kind === "assistant" && !inAssistant) {
    inAssistant = true;
    inReasoning = false;
    addBlock("text", "", fg);
  } else if (kind === "reasoning" && !inReasoning) {
    inReasoning = true;
    inAssistant = false;
    addBlock("reasoning", "", fg);
  }
  appendToBlock(text);
}

function addWrapped(text: string, fg: string): void {
  for (const piece of wrapText(text, Math.max(40, (renderer?.width ?? 100) - 2))) addLine(piece, fg);
}

function writeHistory(e: HistoryEntry): void {
  const fg = e.kind === "user" ? colorUser : e.kind === "tool" || e.kind === "notice" ? colorSoft : "#e0e0e0";
  const head = e.kind === "user" ? "> " : e.kind === "tool" ? "▸ " : "";
  addWrapped(head + e.text, fg);
}

// ---- commands (phase 1+2 set) ----
const helpLines = [
  "/project              프로젝트 목록",
  "/project new <name>   프로젝트 생성+선택",
  "/project <name>       프로젝트 선택",
  "/new [name]           새 세션",
  "/sessions             세션 선택 대화상자",
  "/resume <id|idx>      세션 재개",
  "/model                모델 선택 대화상자",
  "/goal <text>          목표 설정",
  "/compact              컨텍스트 압축",
  "/language <ko|en|zh|ja>",
  "/help, /exit, Esc=중단",
];

let lastProjects: Project[] = [];
let lastSessions: SessionInfo[] = [];

async function listProjects(): Promise<Project[]> {
  const resp = await fetch(restURL(serverAddr, "/api/projects"), {
    headers: { Authorization: "Bearer " + serverToken },
    signal: AbortSignal.timeout(5000),
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { projects?: Project[] } | Project[];
  return Array.isArray(data) ? data : data.projects ?? [];
}

async function fetchModels(): Promise<string[]> {
  const resp = await fetch(restURL(serverAddr, "/api/models?role=agent-chat"), {
    headers: { Authorization: "Bearer " + serverToken },
    signal: AbortSignal.timeout(8000),
  });
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? data.map((m) => String(m)) : [];
}

async function createProject(name: string): Promise<void> {
  const home = process.env.HOME ?? ".";
  const resp = await fetch(restURL(serverAddr, "/api/projects"), {
    method: "POST",
    headers: { Authorization: "Bearer " + serverToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name, machine: "local", workdir: `${home}/Desktop/workspace/${name}` }),
    signal: AbortSignal.timeout(5000),
  });
  if (resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
}

function resolveSession(arg: string): string {
  if (/^\d+$/.test(arg)) {
    const s = lastSessions[Number(arg)];
    return s?.id ?? "";
  }
  return arg;
}

async function execCommand(raw: string): Promise<void> {
  const fields = raw.slice(1).trim().split(/\s+/);
  const name = fields[0] ?? "";
  const arg = raw.slice(1).trim().slice(name.length).trim();
  switch (name) {
    case "exit": {
      cleanup();
      process.exit(0);
      return;
    }
    case "help": {
      for (const l of helpLines) addLine(l, colorSoft);
      return;
    }
    case "new": {
      client?.send({ type: MsgNew, text: arg });
      return;
    }
    case "project": {
      if (arg === "") {
        try {
          lastProjects = await listProjects();
        } catch (err) {
          addLine("프로젝트 조회 실패: " + (err instanceof Error ? err.message : String(err)), colorError);
          return;
        }
        if (lastProjects.length === 0) {
          addLine("프로젝트 없음 — /project new <이름>", colorNotice);
          return;
        }
        setDialog({
          title: "프로젝트 선택",
          options: lastProjects.map((pr) => ({ name: pr.name, description: pr.machine + " · " + pr.workdir, value: pr.name })),
          onPick: (value) => client?.send({ type: MsgProject, text: value }),
        });
        return;
      }
      if (arg.startsWith("new ")) {
        const pname = arg.slice(4).trim();
        await createProject(pname);
        client?.send({ type: MsgProject, text: pname });
        return;
      }
      client?.send({ type: MsgProject, text: arg });
      return;
    }
    case "sessions": {
      if (lastSessions.length === 0) client?.send({ type: MsgSessions });
      else
        setDialog({
          title: "세션 재개",
          options: lastSessions.map((se, i) => ({ name: se.name, description: se.id, value: se.id })),
          onPick: (value) => client?.send({ type: MsgResume, sessionId: value }),
        });
      return;
    }
    case "model": {
      try {
        const models = await fetchModels();
        if (models.length === 0) {
          addLine("사용 가능한 모델이 없습니다.", colorAmber);
          return;
        }
        setDialog({
          title: "모델 선택 (provider: local)",
          options: models.map((mname) => ({ name: mname, description: "", value: mname })),
          onPick: async (value) => {
            const resp = await fetch(restURL(serverAddr, "/api/roles/agent-chat"), {
              method: "PUT",
              headers: { Authorization: "Bearer " + serverToken, "Content-Type": "application/json" },
              body: JSON.stringify({ provider: "local", model: value }),
              signal: AbortSignal.timeout(5000),
            });
            if (resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
            addLine(`모델 변경: ${value}`, colorNotice);
            client?.send({ type: MsgState });
          },
        });
      } catch (err) {
        addLine("모델 조회 실패: " + (err instanceof Error ? err.message : String(err)), colorError);
      }
      return;
    }
    case "resume": {
      const id = resolveSession(arg);
      if (id === "") {
        addLine("사용법: /resume <id|index>  (/sessions 로 목록 확인)", colorAmber);
        return;
      }
      client?.send({ type: MsgResume, sessionId: id });
      return;
    }
    case "goal": {
      client?.send({ type: MsgSetGoal, text: arg });
      return;
    }
    case "compact": {
      client?.send({ type: MsgCompact });
      return;
    }
    case "language": {
      const l = arg as Lang;
      if (validLang(l)) {
        setLang(l);
        saveLang(l);
        addLine(`language: ${l}`, colorSoft);
      } else addLine("사용법: /language <ko|en|zh|ja>", "#ffaa00");
      return;
    }
    default:
      addLine(`알 수 없는 명령: ${name}  (/help)`, colorAmber);
  }
}

// ---- event projection ----
function truncate(s: string, n: number): string {
  const one = s.replace(/\n/g, " ");
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function onEvent(ev: Event): void {
  const width = renderer?.width ?? 100;
  switch (ev.type) {
    case "hello":
      setConn("ok");
      client?.send({ type: MsgSessions });
      break;
    case EvDelta:
      addStream("assistant", ev.text ?? "");
      break;
    case "reasoning":
      addStream("reasoning", ev.text ?? "");
      break;
    case EvToolCall:
      endStreamBlocks();
      addWrapped(`▸ ${ev.name ?? "tool"} ${truncate(ev.args ?? "", 100)}`, colorTool);
      break;
    case EvToolArgs:
      break; // streamed args are noisy; the call line is enough
    case EvToolResult: {
      endStreamBlocks();
      const linesOut = (ev.result ?? "").split("\n").filter((l) => l.trim() !== "");
      for (const l of linesOut.slice(0, 4)) addLine("  " + truncate(l, 120), colorResult);
      if (linesOut.length > 4) addLine(`  … +${linesOut.length - 4} lines`, colorSoft);
      break;
    }
    case EvDone:
      endStreamBlocks();
      promoteLastToMarkdown();
      dropReasoning();
      setBusy(false);
      setStatus("idle");
      break;
    case EvError:
      endStreamBlocks();
      promoteLastToMarkdown();
      dropReasoning();
      addWrapped("오류: " + (ev.error ?? ""), colorError);
      setBusy(false);
      break;
    case EvStatus:
      setStatus(ev.name ?? "");
      setBusy(ev.name === "working");
      break;
    case EvState:
      if (ev.state) {
        setPanel({
          project: ev.state.project,
          model: ev.state.model,
          machine: ev.state.machine,
          ctxUsed: ev.state.ctxUsed,
          ctxMax: ev.state.ctxMax,
          tokens: ev.state.tokens,
          goal: ev.state.goal,
        });
        setSession(ev.session ?? session());
        setTodos(ev.state.todos ?? []);
      }
      break;
    case EvSessions: {
      lastSessions = ev.sessions ?? [];
      setSessionList(lastSessions);
      setSession(ev.session ?? session());
      if (lastSessions.length > 0) {
        addLine(`세션 ${lastSessions.length}: ` + lastSessions.map((s, i) => `[${i}] ${s.name}`).join("  "), colorSoft);
      }
      break;
    }
    case EvHistory:
      for (const e of ev.history ?? []) writeHistory(e);
      break;
    default:
      break;
  }
}

// ---- root UI ----
let inputEl: InputRenderable | undefined;

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x1100 && ch.codePointAt(0)! < 0xff60 ? 2 : 1;
  return w;
}

function padLabel(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visualWidth(s)));
}

interface PanelRow {
  text: string;
  fg?: string;
}

function Footer(props: { onSubmit: (v: string) => void; onEscape: () => void }) {
  const [spin, setSpin] = createSignal(0);
  createEffect(() => {
    const iv = setInterval(() => setSpin((s) => (s + 1) % spinnerFrames.length), 120);
    return () => clearInterval(iv);
  });
  useKeyboard((e) => {
    if (e.name === "escape") {
      if (dialog()) {
        setDialog(null);
        inputEl?.focus();
      } else props.onEscape();
    }
  });
  let statusRef: TextRenderable | undefined;
  let spinRef: TextRenderable | undefined;
  createEffect(() => {
    const p = panel();
    const mark = conn() === "ok" ? "●" : conn() === "connecting" ? "○" : "✗";
    const work = busy() ? ` ${spinnerFrames[spin()]} ${status()}` : "";
    if (statusRef) statusRef.content = `${mark} ${p.project || "-"} · ${p.model || "-"} · ctx ${p.ctxUsed}/${p.ctxMax} · tok ${p.tokens}${work}`;
  });
  createEffect(() => {
    if (spinRef) spinRef.content = busy() ? `${spinnerFrames[spin()]} 진행 중… · Esc 정지` : "";
  });
  return (
    <box style={{ flexDirection: "column" }} width="100%" height={2} flexShrink={0}>
      <text ref={(r) => (spinRef = r)} content="" fg={colorLabel} />
      <input
        ref={(r: InputRenderable) => {
          inputEl = r;
          queueMicrotask(() => {
            if (inputEl && !inputEl.isDestroyed) inputEl.focus();
          });
          r.on("enter", (v: unknown) => {
            props.onSubmit(typeof v === "string" ? v : String(v ?? ""));
            inputEl?.clear();
          });
        }}
        placeholder={`${t().Placeholder}  (/help)`}
        maxLength={4000}
      />
    </box>
  );
}

function Panel() {
  const rows = createMemo<PanelRow[]>(() => {
    const t_ = t();
    const p = panel();
    const out: PanelRow[] = [{ text: " " }, { text: " " }];
    out.push({ text: t_.ProjectLabel, fg: colorLabel });
    out.push({ text: p.project === "" ? t_.None : p.project, fg: p.project === "" ? colorSoft : undefined });
    out.push({ text: " " });
    out.push({ text: t_.SessionLabel, fg: colorLabel });
    if (sessionList().length === 0) out.push({ text: "· " + t_.NoSessions, fg: colorSoft });
    for (const se of sessionList().slice(0, 3)) out.push({ text: "· " + se.name, fg: undefined });
    out.push({ text: " " });
    out.push({ text: "─".repeat(rightPanelWidth - 4), fg: colorLine });
    out.push({ text: " " });
    let pct = 0;
    if (p.ctxMax > 0) pct = Math.min(100, Math.floor((p.ctxUsed * 100) / p.ctxMax));
    const filled = Math.floor((pct * 8) / 100);
    const gauge = `${"█".repeat(filled)}${"░".repeat(8 - filled)} ${String(pct).padStart(3)}%`;
    const labelW = 10;
    out.push({ text: padLabel(t_.ModelLabel, labelW) + (p.model || t_.None), fg: p.model ? undefined : colorSoft });
    out.push({ text: padLabel(t_.MachineLabel, labelW) + (p.machine || t_.None), fg: p.machine ? undefined : colorSoft });
    out.push({ text: padLabel(t_.ContextLabel, labelW) + gauge, fg: undefined });
    out.push({ text: padLabel(t_.GoalLabel, labelW) + (p.goal || t_.None), fg: p.goal ? undefined : colorSoft });
    out.push({ text: " " });
    out.push({ text: t_.TodoLabel, fg: colorLabel });
    const td = todos();
    if (td.length === 0) out.push({ text: "· " + t_.None, fg: colorSoft });
    for (const item of td.slice(0, 3)) out.push({ text: "· " + item, fg: undefined });
    return out;
  });
  return (
    <box style={{ flexDirection: "column" }} width={rightPanelWidth} height="100%" paddingLeft={1}>
      <For each={rows()}>{(r) => <text content={r.text} fg={r.fg} />}</For>
    </box>
  );
}

function Rule(props: { height: number }) {
  const rows = () => Array.from({ length: Math.max(0, props.height) }, (_, i) => i);
  return (
    <box style={{ flexDirection: "column" }} width={1} height={props.height}>
      <For each={rows()}>{() => <text content="│" fg={colorLine} />}</For>
    </box>
  );
}

function Root() {
  const dims = useTerminalDimensions();
  const syntaxStyle = createMemo(() => SyntaxStyle.create(renderer!.nativeScene));
  const bodyH = () => Math.max(4, dims().height - 5);
  return (
    <box style={{ flexDirection: "column" }} width={dims().width} height={dims().height}>
      <box style={{ flexDirection: "row" }} width="100%" height={1}>
        <box backgroundColor={colorDeep} width={8} height={1}>
          <text content=" KIWI " fg="#ffffff" />
        </box>
        <Show
          when={conn() === "ok"}
          fallback={<text content={"✗ " + t().Disconnected} fg={colorBadgeOff} />}
        >
          <text content={"● " + t().Connected + (busy() ? " · " + status() : "")} fg={colorBadgeOn} />
        </Show>
      </box>
      <box style={{ flexDirection: "row" }} width="100%" height={bodyH()}>
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          style={{ flexGrow: 1, height: "100%", paddingLeft: 1, paddingRight: 1 }}
          scrollbarOptions={{ visible: true, trackOptions: { backgroundColor: "#24292f" } }}
        >
          <For each={blocks()}>
            {(b) => (
              <Show when={b.kind === "md"} fallback={<text content={b.text} fg={b.fg} />}>
                <markdown content={b.text} syntaxStyle={syntaxStyle()} />
              </Show>
            )}
          </For>
        </scrollbox>
        <Rule height={bodyH()} />
        <Panel />
      </box>
      <text content={"─".repeat(Math.max(10, dims().width - 2))} fg={colorLine} />
      <Show when={dialog()} keyed>
        {(d: Dialog) => {
          return (
          <box
            position="absolute"
            zIndex={3000}
            left={4}
            top={2}
            width={dims().width - 8}
            height={Math.min(d.options.length + 2, 14)}
            border
            title={d.title}
            backgroundColor="#161b22"
          >
            <select
              focused
              height={d.options.length}
              width="100%"
              options={d.options}
              onSelect={(_idx, option) => {
                const pick = d.onPick;
                queueMicrotask(() => {
                  setDialog(null);
                  inputEl?.focus();
                  if (option) pick(option.value);
                });
              }}
            />
          </box>
        );
        }}
      </Show>
      <Footer
        onSubmit={(v) => {
          const text = v.trim();
          if (text === "") return;
          if (text.startsWith("/")) {
            execCommand(text).catch((err) => addWrapped("오류: " + (err instanceof Error ? err.message : String(err)), colorError));
          } else {
            addLine("> " + text, colorUser);
            client?.send({ type: MsgSend, text });
          }
        }}
        onEscape={() => {
          if (busy() && client) {
            client.send({ type: MsgStop });
            addLine("중단 요청", colorAmber);
          }
        }}
      />
      <text content={t().HelpLeft + "   " + t().HelpRight} fg={colorSoft} />
    </box>
  );
}

// ---- lifecycle ----
function cleanup(): void {
  client?.close();
  try {
    renderer?.destroy();
  } catch {
    /* ignore */
  }
}

export async function run(): Promise<void> {
  const cfg = loadConfig();
  if (validLang(cfg.language)) setLang(cfg.language);
  serverAddr = cfg.server ?? process.env.KIWI_ADDR ?? "localhost:5494";
  serverToken = cfg.token ?? process.env.KIWI_TOKEN ?? "";
  if (serverToken === "") {
    console.error("kiwi-server 토큰이 없습니다. 구 TUI에서 /server 저장 후 재실행하거나 KIWI_TOKEN을 설정하세요.");
    process.exit(1);
  }

  renderer = await createCliRenderer({ targetFps: 30, useMouse: true, screenMode: "alternate-screen" });

  try {
    client = await WSClient.dial(serverAddr, serverToken);
  } catch (err) {
    addLine("연결 실패: " + (err instanceof Error ? err.message : String(err)), colorError);
    setTimeout(() => process.exit(1), 300);
    return;
  }
  client.onEvent = onEvent;
  client.onClose = () => {
    setConn("closed");
    addLine("연결이 끊겼습니다.", colorError);
  };
  setConn("ok");

  render(() => <Root />, renderer);
  process.on("exit", cleanup);
}
