import { useCallback, useEffect, useRef, useState } from "react";
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
  MsgNew,
  MsgProject,
  MsgSend,
  MsgStop,
  wsURL,
  type Event,
  type PanelState,
  type Project,
} from "./kiwi";

const COLORS: Record<string, string> = {
  user: "#7fd7ff",
  assistant: "#e8eadf",
  reasoning: "#7d8377",
  tool: "#a8c17a",
  result: "#b9b39f",
  notice: "#8fce5a",
  error: "#d98a4a",
};

interface Block {
  id: number;
  kind: keyof typeof COLORS;
  text: string;
}

let nextId = 1;

export default function App(): React.ReactElement {
  const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY) ?? "");
  const [tokenDraft, setTokenDraft] = useState("");
  const [conn, setConn] = useState<"connecting" | "ok" | "closed">("connecting");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState("");

  const [everOk, setEverOk] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inAssistant = useRef(false);
  const inReasoning = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const addBlock = useCallback((kind: Block["kind"], text: string): void => {
    setBlocks((prev) => [...prev, { id: nextId++, kind, text }]);
  }, []);

  const appendBlock = useCallback((text: string): void => {
    setBlocks((prev) => {
      if (prev.length === 0) return prev;
      const copy = prev.slice();
      const last = copy[copy.length - 1]!;
      copy[copy.length - 1] = { ...last, text: last.text + text };
      return copy;
    });
  }, []);

  const endStream = useCallback((): void => {
    inAssistant.current = false;
    inReasoning.current = false;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const send = useCallback((msg: { type: string; text?: string }): void => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const onEvent = useCallback(
    (ev: Event): void => {
      switch (ev.type) {
        case "hello":
          setConn("ok");
          send({ type: "sessions" });
          break;
        case EvDelta:
          if (!inAssistant.current) {
            inAssistant.current = true;
            inReasoning.current = false;
            addBlock("assistant", "");
          }
          appendBlock(ev.text ?? "");
          break;
        case "reasoning":
          if (!inReasoning.current) {
            inReasoning.current = true;
            inAssistant.current = false;
            addBlock("reasoning", "");
          }
          appendBlock(ev.text ?? "");
          break;
        case EvToolCall:
          endStream();
          addBlock("tool", `▸ ${ev.name ?? "tool"} ${(ev.args ?? "").replace(/\n/g, " ").slice(0, 100)}`);
          break;
        case EvToolArgs:
          break;
        case EvToolResult: {
          endStream();
          const lines = (ev.result ?? "").split("\n").filter((l) => l.trim() !== "");
          for (const l of lines.slice(0, 4)) addBlock("result", "  " + l.slice(0, 120));
          if (lines.length > 4) addBlock("result", `  … +${lines.length - 4} lines`);
          break;
        }
        case EvDone:
          endStream();
          setBusy(false);
          setStatus("idle");
          break;
        case EvError:
          endStream();
          addBlock("error", "오류: " + (ev.error ?? ""));
          setBusy(false);
          break;
        case EvStatus:
          setStatus(ev.name ?? "");
          setBusy(ev.name === "working");
          break;
        case EvSessions:
          break;
        case EvHistory: {
          for (const h of ev.history ?? []) {
            const kind = h.kind === "user" ? "user" : h.kind === "tool" || h.kind === "notice" ? "result" : "assistant";
            const head = h.kind === "user" ? "> " : h.kind === "tool" ? "▸ " : "";
            addBlock(kind as Block["kind"], head + h.text);
          }
          break;
        }
        case EvState:
          if (ev.state) setPanel(ev.state);
          break;
        default:
          break;
      }
    },
    [addBlock, appendBlock, endStream, send],
  );

  useEffect(() => {
    const ws = new WebSocket(wsURL(location.host, token));
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)) as Event);
      } catch {
        // ignore malformed
      }
    };
    ws.onopen = () => {
      setEverOk(true);
      setConn("ok");
      ws.send(JSON.stringify({ type: "sessions" }));
    };
    ws.onclose = () => setConn("closed");
    ws.onerror = () => setConn("closed");
    return () => {
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    };
  }, [token, onEvent]);

  useEffect(() => {
    if (conn !== "ok") return;
    fetch("/api/projects", { headers: { Authorization: "Bearer " + token } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Project[] | { projects: Project[] }) => {
        setProjects(Array.isArray(data) ? data : data.projects ?? []);
      })
      .catch(() => {});
  }, [conn, token]);

  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (text === "") return;
      if (text === "/new") {
        send({ type: MsgNew, text: "" });
        setBlocks([]);
        return;
      }
      addBlock("user", "> " + text);
      send({ type: MsgSend, text });
    },
    [addBlock, send],
  );

  const onSubmit = useCallback((): void => {
    const text = draft;
    if (text.trim() === "" || busy) return;
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    submit(text);
  }, [draft, busy, submit]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit],
  );

  const pickProject = useCallback(
    (name: string): void => {
      if (name === "") return;
      send({ type: MsgProject, text: name });
      send({ type: MsgNew, text: "" });
      setBlocks([]);
    },
    [send],
  );

  if (conn === "closed" && !everOk) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-3">
          <div className="text-lg font-bold">Kiwi</div>
          <div className="text-sm text-neutral-500">서버가 인증을 요구합니다. 토큰을 입력하세요</div>
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-neutral-500"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="token"
            onKeyDown={(e) => {
              if (e.key === "Enter" && tokenDraft.trim() !== "") {
                localStorage.setItem(TOKEN_KEY, tokenDraft.trim());
                setToken(tokenDraft.trim());
              }
            }}
          />
          <button
            className="w-full rounded bg-emerald-800 px-3 py-2 font-medium hover:bg-emerald-700"
            onClick={() => {
              if (tokenDraft.trim() !== "") {
                localStorage.setItem(TOKEN_KEY, tokenDraft.trim());
                setToken(tokenDraft.trim());
              }
            }}
          >
            연결
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="rounded bg-[#3c5e20] px-2 py-0.5 text-sm font-bold text-white">KIWI</span>
        <span className={`text-xs ${conn === "ok" ? "text-emerald-400" : conn === "connecting" ? "text-neutral-500" : "text-red-400"}`}>
          {conn === "ok" ? "● 연결됨" : conn === "connecting" ? "○ 연결 중" : "✗ 끊김"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            value={panel?.project ?? ""}
            onChange={(e) => pickProject(e.target.value)}
          >
            <option value="">프로젝트…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name} ({p.machine})
              </option>
            ))}
          </select>
          <button
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
            onClick={() => {
              send({ type: MsgNew, text: "" });
              setBlocks([]);
            }}
          >
            + 새 세션
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {blocks.length === 0 && (
          <div className="pt-8 text-center text-sm text-neutral-600">
            프로젝트를 선택하고 메시지를 입력하세요.
          </div>
        )}
        {blocks.map((b) => (
          <div
            key={b.id}
            className="whitespace-pre-wrap break-words text-sm leading-relaxed"
            style={{ color: COLORS[b.kind], fontWeight: b.kind === "user" || b.kind === "tool" ? 600 : 400 }}
          >
            {b.text}
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-800 px-3 py-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        {busy && (
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs text-[#a8c17a]">⠿ {status}…</span>
            <button
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
              onClick={() => send({ type: MsgStop, text: "" })}
            >
              정지 (Esc)
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            placeholder="메시지 입력… (Shift+Enter 줄바꿈)"
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={onKeyDown}
          />
          <button
            className="rounded bg-emerald-800 px-4 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-40"
            disabled={busy || draft.trim() === ""}
            onClick={onSubmit}
          >
            전송
          </button>
        </div>
      </div>
    </div>
  );
}

const TOKEN_KEY = "kiwi-token";
