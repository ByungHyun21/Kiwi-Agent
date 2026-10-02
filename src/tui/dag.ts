export type NodeState =
  | "pending"
  | "blocked"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type Activity = {
  phase: "waiting" | "text" | "thinking" | "toolArgs" | "tool" | "retry";
  sinceMs: number;
  lastAtMs: number;
  tool?: string;
  attempt?: number;
  maxAttempts?: number;
};

export type DagNode = { id: string; label: string; state: NodeState; activity?: Activity };

export type DagEdge = { from: string; to: string };

export const NODE_ICONS: Record<NodeState, string> = {
  pending: "○",
  blocked: "◌",
  scheduled: "◷",
  running: "●",
  completed: "✓",
  failed: "×",
  cancelled: "−",
  skipped: "·",
};

export const NODE_COLORS: Record<NodeState, string> = {
  pending: "",
  blocked: "\x1b[33m",
  scheduled: "\x1b[36m",
  running: "\x1b[36m",
  completed: "\x1b[32m",
  failed: "\x1b[31m",
  cancelled: "",
  skipped: "",
};

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function strWidth(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    for (const ch of segment) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  }
  return w;
}

export function fit(s: string, cols: number): string {
  if (cols <= 0) return "";
  if (strWidth(s) <= cols) return s;
  const ell = "…";
  const segs = [...segmenter.segment(s)].map((d) => d.segment);
  let out = "";
  let w = 0;
  for (const seg of segs) {
    const sw = strWidth(seg);
    if (w + sw > cols - strWidth(ell)) break;
    out += seg;
    w += sw;
  }
  return out + ell;
}

export function fitTail(s: string, cols: number): string {
  if (cols <= 0) return "";
  if (strWidth(s) <= cols) return s;
  const ell = "…";
  const segs = [...segmenter.segment(s)].map((d) => d.segment);
  let out = "";
  let w = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    const sw = strWidth(segs[i]);
    if (w + sw > cols - strWidth(ell)) break;
    out = segs[i] + out;
    w += sw;
  }
  return ell + out;
}

export function dagLayers(nodes: DagNode[], edges: DagEdge[]): string[][] {
  if (nodes.length === 0) return [];
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    succ.set(n.id, []);
    preds.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    succ.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const queue: string[] = [];
  for (const n of nodes) if (indeg.get(n.id) === 0) queue.push(n.id);
  const layerOf = new Map<string, number>();
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    const l = preds.get(id)!.reduce((m, p) => Math.max(m, layerOf.get(p)! + 1), 0);
    layerOf.set(id, l);
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (processed < nodes.length) throw new Error("dag contains a cycle");
  const maxLayer = Math.max(0, ...layerOf.values());
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)!].push(n.id);
  return layers;
}

function clip(s: string, cols: number): string {
  if (strWidth(s) <= cols) return s + " ".repeat(cols - strWidth(s));
  return fit(s, cols);
}

export function dagRenderFrame(
  width: number,
  nodes: DagNode[],
  edges: DagEdge[],
  opts?: { selectedId?: string },
): string[] {
  if (nodes.length === 0) return [""];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = dagLayers(nodes, edges);
  const boxW = Math.max(10, Math.min(24, Math.floor((width - 4) / Math.max(...layers.map((l) => l.length)))));
  const lines: string[] = [];

  const box = (n: DagNode, isActive: boolean): string => {
    const inner = `${NODE_ICONS[n.state]} ${clip(n.label, Math.max(1, boxW - 4))}`;
    return isActive ? `▐${inner}▌` : ` ${inner} `;
  };

  const rowPositions: Map<string, number>[] = [];
  layers.forEach((layer) => {
    const cells = layer.map((id) => {
      const n = byId.get(id)!;
      const active = n.state === "running" || n.state === "failed" || id === opts?.selectedId;
      return { id, text: NODE_COLORS[n.state] === "" ? box(n, active) : `${NODE_COLORS[n.state]}${box(n, active)}\x1b[0m` };
    });
    lines.push(cells.map((c) => c.text).join("  "));
    const pos = new Map<string, number>();
    let col = 0;
    for (const c of cells) {
      pos.set(c.id, col + Math.floor(strWidth(c.text) / 2));
      col += strWidth(c.text) + 2;
    }
    rowPositions.push(pos);
  });

  for (let li = 1; li < layers.length; li++) {
    const prev = rowPositions[li - 1];
    const cur = rowPositions[li];
    if (prev.size === 0 || cur.size === 0) continue;
    const lineW = Math.max(width, 4);
    const grid: string[][] = Array.from({ length: 3 }, () => Array.from({ length: lineW }, () => " "));
    const at = (r: number, c: number) => (r >= 0 && r < 3 && c >= 0 && c < lineW ? grid[r][c] : "");
    const put = (r: number, c: number, ch: string) => {
      if (r >= 0 && r < 3 && c >= 0 && c < lineW) {
        const old = grid[r][c];
        if (old === " ") grid[r][c] = ch;
        else if (old !== ch && (old === "─" || old === "│") && (ch === "─" || ch === "│")) grid[r][c] = "┼";
      }
    };
    for (const e of edges) {
      const sc = prev.get(e.from);
      const tc = cur.get(e.to);
      if (sc === undefined || tc === undefined) continue;
      if (sc === tc) {
        put(0, sc, "│");
        put(1, sc, "│");
        grid[2][tc] = "▼";
        continue;
      }
      const c0 = Math.min(sc, tc);
      const c1 = Math.max(sc, tc);
      put(0, sc, "│");
      for (let c = c0; c <= c1; c++) put(1, c, "─");
      grid[2][tc] = "▼";
      grid[1][sc] = sc < tc ? "└" : "┘";
      grid[1][tc] = sc < tc ? "┐" : "┌";
    }
    for (const row of grid) lines.push(row.join("").trimEnd());
  }
  return lines.map((l) => (strWidth(l) > width ? [...segmenter.segment(l)].map((d) => d.segment).reduce((acc, seg) => (strWidth(acc + seg) <= width ? acc + seg : acc), "") : l));
}

const PHASE_MARKS: Record<Activity["phase"], string> = {
  text: "✎",
  thinking: "💭",
  toolArgs: "⚙",
  waiting: "⏳",
  tool: "▶",
  retry: "↻",
};

const TOKEN_STALL_MS = 30000;
const WAIT_STALL_MS = 90000;

export function activitySummary(
  a: { phase: Activity["phase"]; sinceMs: number; lastAtMs: number; tool?: string; attempt?: number; maxAttempts?: number },
  nowMs: number,
): { head: string; stalled: boolean } {
  const mark = PHASE_MARKS[a.phase];
  const elapsedSec = Math.floor((nowMs - a.sinceMs) / 1000);
  const idleMs = nowMs - a.lastAtMs;
  const stalled = a.phase === "waiting" ? elapsedSec * 1000 >= WAIT_STALL_MS : idleMs >= TOKEN_STALL_MS;
  let head: string;
  switch (a.phase) {
    case "text":
    case "thinking":
    case "toolArgs":
      head = `${mark} 방금`;
      break;
    case "tool":
      head = `${mark} ${a.tool ?? "tool"} · ${elapsedSec}초`;
      break;
    case "waiting":
      head = `${mark} 대기 ${elapsedSec}초`;
      break;
    case "retry":
      head = `${mark} 재시도 ${a.attempt ?? "?"}/${a.maxAttempts ?? "?"}`;
      break;
  }
  if (stalled) head = `⚠ 정지 의심 · ${head}`;
  return { head, stalled };
}
