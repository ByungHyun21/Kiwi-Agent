// Transcript: streaming conversation lines, wrap caching and scrolling.

import type { Event } from "../protocol.ts";
import { displayWidth, truncateAnsi } from "./ansi.ts";
import { Style } from "./style.ts";
import { renderMarkdown } from "./markdown.ts";
import { errStyle } from "./styles.ts";
import type { Model } from "./model.ts";

/** lineKind marks one transcript entry for visual separation. */
export enum LineKind {
  User = 0,
  Assistant = 1,
  Reasoning = 2,
  Tool = 3,
  Result = 4,
  Error = 5,
  Notice = 6,
}

export interface TLine {
  kind: LineKind;
  text: string;
  wrapped: string[] | null; // display lines, cached
  wrapWidth: number; // width the cache was built for
  live: boolean; // cached as a plain streaming line
}

export function tline(kind: LineKind, text: string): TLine {
  return { kind, text, wrapped: null, wrapWidth: 0, live: false };
}

const userStyle = new Style().bold(true).foreground("#e8eadf");
const reasoningStyle = new Style().foreground("#7d8377");
const toolStyle = new Style().foreground("#a8c17a").bold(true);
const resultStyle = new Style().foreground("#b9b39f");
const noticeStyle = new Style().foreground("#8fce5a");

function marker(k: LineKind): string {
  switch (k) {
    case LineKind.User:
      return "▶ ";
    case LineKind.Reasoning:
      return "· ";
    case LineKind.Tool:
      return "⚒ ";
    case LineKind.Result:
      return "│ ";
    case LineKind.Error:
      return "✗ ";
    case LineKind.Notice:
      return "◆ ";
    default:
      return "";
  }
}

function styleOf(k: LineKind): Style {
  switch (k) {
    case LineKind.User:
      return userStyle;
    case LineKind.Reasoning:
      return reasoningStyle;
    case LineKind.Tool:
      return toolStyle;
    case LineKind.Result:
      return resultStyle;
    case LineKind.Error:
      return errStyle;
    case LineKind.Notice:
      return noticeStyle;
    default:
      return new Style();
  }
}

/** displayLines returns the wrapped display lines for one entry, using and
 *  maintaining a per-entry cache so streaming deltas only re-wrap the
 *  growing line instead of the whole transcript. */
export function displayLines(ln: TLine, width: number, live: boolean): string[] {
  if (ln.wrapped !== null && ln.wrapWidth === width && ln.live === live) {
    return ln.wrapped;
  }
  if (ln.text === "") {
    ln.wrapped = [""];
    ln.wrapWidth = width;
    ln.live = live;
    return ln.wrapped;
  }
  // finished assistant messages render as markdown (tables, code blocks);
  // the currently-streaming line stays plain to keep frames cheap
  if (ln.kind === LineKind.Assistant && !live) {
    const md = renderMarkdown(width, ln.text);
    if (md !== null) {
      ln.wrapped = md;
      ln.wrapWidth = width;
      ln.live = live;
      return ln.wrapped;
    }
  }
  const style = styleOf(ln.kind).width(width);
  const block = style.render(marker(ln.kind) + ln.text.replace(/\n+$/, ""));
  ln.wrapped = block.split("\n");
  ln.wrapWidth = width;
  ln.live = live;
  return ln.wrapped;
}

/** invalidate drops the wrap cache (text changed). */
export function invalidate(ln: TLine): void {
  ln.wrapped = null;
  ln.wrapWidth = 0;
  ln.live = false;
}

/** invalidateLast drops the cache of the final entry (turn closed). */
export function invalidateLast(m: Model): void {
  if (m.transcript.length > 0) invalidate(m.transcript[m.transcript.length - 1]!);
}

/** applyEvent folds one server event into the transcript. */
export function applyEvent(m: Model, ev: Event): void {
  switch (ev.type) {
    case "delta":
      appendStream(m, LineKind.Assistant, ev.text ?? "");
      break;
    case "reasoning":
      appendStream(m, LineKind.Reasoning, ev.text ?? "");
      break;
    case "tool_args": {
      if (m.streamKind !== LineKind.Tool || m.toolArgsName !== ev.name) {
        m.toolArgsName = ev.name ?? "";
        appendStream(m, LineKind.Tool, "⚒ " + (ev.name ?? "") + " ");
      }
      appendStream(m, LineKind.Tool, ev.text ?? "");
      break;
    }
    case "tool_call": {
      m.curTool = ev.name ?? "";
      if (m.streamKind === LineKind.Tool && m.toolArgsName === ev.name) {
        // arguments already streamed raw; the final call adds nothing
        m.streamKind = -1;
        break;
      }
      let args = ev.args ?? "";
      if (args.length > 120) args = args.slice(0, 120) + "…";
      m.transcript.push(tline(LineKind.Tool, "⚒ " + (ev.name ?? "") + " " + args));
      m.streamKind = -1;
      break;
    }
    case "tool_result":
      m.curTool = "";
      m.transcript.push(tline(LineKind.Result, ev.result ?? ""));
      m.streamKind = -1;
      break;
    case "error":
      m.transcript.push(tline(LineKind.Error, ev.error ?? ""));
      m.streamKind = -1;
      break;
    case "status": {
      const wasBusy = m.busy;
      m.busy = ev.name === "working";
      if (wasBusy && !m.busy) invalidateLast(m);
      if (ev.name !== "working" && ev.name !== "idle") {
        m.transcript.push(tline(LineKind.Notice, statusText(ev.name ?? "")));
      }
      m.streamKind = -1;
      break;
    }
    case "done":
      m.streamKind = -1;
      invalidateLast(m);
      break;
    case "state":
      if (ev.session) m.currentSession = ev.session;
      if (ev.state) {
        m.project = ev.state.project;
        m.machine = ev.state.machine;
        m.model = ev.state.model;
        m.goal = ev.state.goal;
        m.ctxUsed = ev.state.ctxUsed;
        m.ctxMax = ev.state.ctxMax;
        if (ev.state.tokens > 0) m.tokens = ev.state.tokens;
      }
      break;
    case "history":
      m.transcript = [];
      m.streamKind = -1;
      m.scroll = -1;
      for (const h of ev.history ?? []) {
        m.transcript.push(tline(historyKind(h.kind), h.text));
      }
      break;
    case "sessions":
      m.sessions = (ev.sessions ?? []).map((s) => s.name);
      m.sessionIDs = ev.sessions ?? [];
      break;
  }
}

/** appendStream continues the last line of the same kind or starts a new one. */
export function appendStream(m: Model, kind: LineKind, text: string): void {
  if (m.streamKind === kind && m.transcript.length > 0) {
    const last = m.transcript[m.transcript.length - 1]!;
    last.text += text;
    invalidate(last);
    return;
  }
  m.transcript.push(tline(kind, text));
  m.streamKind = kind;
}

function historyKind(k: string): LineKind {
  switch (k) {
    case "user":
      return LineKind.User;
    case "assistant":
      return LineKind.Assistant;
    case "tool":
      return LineKind.Tool;
    case "result":
      return LineKind.Result;
    default:
      return LineKind.Notice;
  }
}

function statusText(name: string): string {
  switch (name) {
    case "queued":
      return "작업 중이라 대기열에 추가했습니다";
    case "stopped":
      return "작업을 중단했습니다";
    case "compacted":
      return "컨텍스트를 압축했습니다";
    default:
      return name;
  }
}

/** totalWrapped flattens cached display lines: entries + one blank separator.
 *  The last entry is rendered plain while a turn is streaming. */
export function totalWrapped(m: Model, width: number): string[] {
  const lines: string[] = [];
  const last = m.transcript.length - 1;
  for (let i = 0; i < m.transcript.length; i++) {
    const live = m.busy && i === last;
    lines.push(...displayLines(m.transcript[i]!, width, live));
    lines.push("");
  }
  return lines;
}

/** renderTranscript renders the transcript window. scroll<0 means stick to
 *  the bottom (auto-follow); scroll>=0 is a line offset from the top. */
export function renderTranscript(m: Model, width: number, height: number): string {
  if (height <= 0) return "";
  const lines = totalWrapped(m, width);
  if (lines.length <= height) return lines.join("\n");
  // note: like the Go original, the follow offset is computed per render
  let offset = m.scroll < 0 ? lines.length - height : m.scroll;
  if (offset > lines.length - height) offset = lines.length - height;
  if (offset < 0) offset = 0;
  return lines.slice(offset, offset + height).join("\n");
}

/** scrolledUp reports whether the view is detached from the bottom. */
export function scrolledUp(m: Model, width: number, height: number): boolean {
  if (m.scroll < 0) return false;
  const lines = totalWrapped(m, width);
  return m.scroll < lines.length - height;
}

/** scrollBy moves the view offset, clamped; negative delta follows the tail. */
export function scrollBy(m: Model, width: number, height: number, delta: number): void {
  const lines = totalWrapped(m, width);
  let max = lines.length - height;
  if (max < 0) max = 0;
  let pos = m.scroll;
  if (pos < 0) pos = max;
  pos += delta;
  if (pos > max) pos = max;
  if (pos < 0) pos = 0;
  if (pos >= max) m.scroll = -1; // re-attach to the bottom
  else m.scroll = pos;
}

export { truncateAnsi, displayWidth };
