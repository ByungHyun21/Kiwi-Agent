import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EvDelta,
  EvDone,
  EvError,
  EvHistory,
  EvNotice,
  EvSessions,
  EvState,
  EvStatus,
  EvToolArgs,
  EvToolCall,
  EvToolResult,
  MsgNew,
  MsgProject,
  MsgResume,
  MsgSend,
  MsgSetThink,
  MsgStop,
  THINK_LEVELS,
  type Event,
  type PanelState,
  type Project,
  type ProviderModelGroup,
  type RoleInfo,
  type SessionInfo,
  type ThinkLevel,
} from "../../src/shared/protocol";
import { parseSlashCommand, slashHint, type ParsedSlashCommand } from "../../src/shared/slash";
import { api, errMsg, wsURL } from "./api";
import Admin from "./Admin";

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

export default function App({ onHome }: { onHome?: () => void } = {}): React.ReactElement {
  const [conn, setConn] = useState<"connecting" | "ok" | "closed">("connecting");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionID, setSessionID] = useState("");
  const [draft, setDraft] = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [role, setRole] = useState<RoleInfo | null>(null);
  const [modelGroups, setModelGroups] = useState<ProviderModelGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkMenuOpen, setThinkMenuOpen] = useState(false);

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

  const send = useCallback((msg: { type: string; text?: string; sessionId?: string; projectId?: string }): void => {
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
        case EvNotice:
          addBlock("notice", ev.text ?? "");
          break;
        case EvStatus:
          setStatus(ev.name ?? "");
          if (ev.name === "working" || ev.name === "queued") setBusy(true);
          if (ev.name === "idle" || ev.name === "stopped") setBusy(false);
          break;
        case EvSessions:
          setSessions(ev.sessions ?? []);
          break;
        case EvHistory: {
          if (ev.session) setSessionID(ev.session);
          endStream();
          setBlocks((ev.history ?? []).map((h) => {
            const kind: Block["kind"] =
              h.kind === "user" ? "user"
              : h.kind === "tool" || h.kind === "notice" ? "result"
              : h.kind === "reasoning" ? "reasoning"
              : "assistant";
            const head = h.kind === "user" ? "> " : h.kind === "tool" ? "▸ " : "";
            return { id: nextId++, kind, text: head + h.text };
          }));
          break;
        }
        case EvState:
          if (ev.state) setPanel(ev.state);
          if (ev.session) setSessionID(ev.session);
          break;
        default:
          break;
      }
    },
    [addBlock, appendBlock, endStream, send],
  );

  useEffect(() => {
    const ws = new WebSocket(wsURL());
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)) as Event);
      } catch {
        // ignore malformed
      }
    };
    ws.onopen = () => {
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
  }, [onEvent]);

  useEffect(() => {
    if (conn !== "ok") return;
    api<Project[] | { projects: Project[] }>("/api/projects")
      .then((data) => {
        setProjects(Array.isArray(data) ? data : data.projects ?? []);
      })
      .catch(() => {});
  }, [conn]);

  useEffect(() => {
    if (conn !== "ok") return;
    api<RoleInfo>("/api/roles/agent-chat")
      .then(setRole)
      .catch(() => {});
  }, [conn]);

  const loadModels = useCallback(async (refresh = false): Promise<void> => {
    setModelsLoading(true);
    try {
      const groups = await api<ProviderModelGroup[]>(`/api/models?all=1${refresh ? "&refresh=1" : ""}`);
      setModelGroups(groups);
    } catch (err) {
      addBlock("error", "모델 목록을 불러오지 못했습니다: " + errMsg(err));
    } finally {
      setModelsLoading(false);
    }
  }, [addBlock]);

  const openModelMenu = useCallback((): void => {
    setModelMenuOpen(true);
    setThinkMenuOpen(false);
    void loadModels();
  }, [loadModels]);

  const chooseModel = useCallback(async (provider: string, model: string): Promise<void> => {
    setModelMenuOpen(false);
    try {
      const next = await api<RoleInfo>("/api/roles/agent-chat", {
        method: "PUT",
        body: JSON.stringify({ provider, model }),
      });
      setRole(next);
      send({ type: "state" });
    } catch (err) {
      addBlock("error", "모델 변경 실패: " + errMsg(err));
    }
  }, [addBlock, send]);

  const pickThink = useCallback((level: ThinkLevel): void => {
    setThinkMenuOpen(false);
    send({ type: MsgSetThink, text: level });
  }, [send]);

  const clientCommands = useMemo(() => new Map<string, (cmd: ParsedSlashCommand) => boolean>([
    ["model", () => {
      openModelMenu();
      return true;
    }],
    ["new", () => {
      send({ type: MsgNew, text: "" });
      setBlocks([]);
      setSessionID("");
      return true;
    }],
    ["think", (cmd) => {
      if (cmd.args.length > 0) return false;
      setThinkMenuOpen(true);
      setModelMenuOpen(false);
      return true;
    }],
  ]), [openModelMenu, send]);

  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (text === "") return;

      const cmd = parseSlashCommand(text);
      if (cmd?.spec) {
        const run = clientCommands.get(cmd.name);
        if (run?.(cmd)) return;
        if (cmd.spec.target === "server") {
          // Server commands never enter the model conversation or history.
          send({ type: MsgSend, text });
          return;
        }
        addBlock("error", `/${cmd.name} 명령을 처리할 수 없습니다. 사용법: ${cmd.spec.usage}`);
        return;
      }

      addBlock("user", "> " + text);
      send({ type: MsgSend, text });
    },
    [addBlock, clientCommands, send],
  );

  const onSubmit = useCallback((): void => {
    const text = draft;
    if (text.trim() === "") return;
    if (busy && !parseSlashCommand(text)?.spec?.runWhileBusy) return;
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
      setSessionID("");
    },
    [send],
  );

  const currentModel = role?.model ?? panel?.model ?? "모델…";
  const currentThink = panel?.think ?? "auto";
  const draftHint = slashHint(draft);
  const activity = busy
    ? status === "queued" ? "대기 중…" : "생성 중…"
    : draft.trim() !== "" ? "입력 중…" : "준비됨";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="rounded bg-[#3c5e20] px-2 py-0.5 text-sm font-bold text-white">KIWI</span>
        {onHome ? (
          <button className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800" onClick={onHome}>
            홈
          </button>
        ) : null}
        <span className={`text-xs ${conn === "ok" ? "text-emerald-400" : conn === "connecting" ? "text-neutral-500" : "text-red-400"}`}>
          {conn === "ok" ? "● 연결됨" : conn === "connecting" ? "○ 연결 중" : "✗ 끊김"}
        </span>
        {panel && panel.ctxMax > 0 && (
          <span className="text-xs text-neutral-500" title="현재 세션 컨텍스트 / 모델 컨텍스트 창">
            {formatTokens(panel.ctxUsed)} / {formatTokens(panel.ctxMax)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            className="max-w-[10rem] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs disabled:opacity-40"
            value={panel?.project ?? ""}
            disabled={busy}
            onChange={(e) => pickProject(e.target.value)}
          >
            <option value="">프로젝트…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name} ({p.machine})
              </option>
            ))}
          </select>
          <select
            className="max-w-[13rem] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs disabled:opacity-40"
            value={sessionID}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              if (id === "") return;
              setBlocks([]);
              send({ type: MsgResume, sessionId: id });
            }}
          >
            <option value="">세션…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.project ? ` · ${s.project}` : ""}
              </option>
            ))}
          </select>
          <button
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
            disabled={busy}
            onClick={() => {
              send({ type: MsgNew, text: "" });
              setBlocks([]);
              setSessionID("");
            }}
          >
            + 새 세션
          </button>
          <button
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
            onClick={() => setShowAdmin(true)}
          >
            관리
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
        {(modelMenuOpen || thinkMenuOpen) && (
          <div
            className="fixed inset-0 z-20"
            onClick={() => {
              setModelMenuOpen(false);
              setThinkMenuOpen(false);
            }}
          />
        )}

        <div className="flex items-center gap-2 pb-1">
          <span className={`flex items-center gap-1 text-xs ${busy ? "text-[#a8c17a]" : draft.trim() !== "" ? "text-neutral-400" : "text-neutral-600"}`}>
            <span className={busy ? "animate-pulse" : ""}>{busy ? "●" : draft.trim() !== "" ? "✎" : "○"}</span>
            {activity}
          </span>
          {busy && (
            <button
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
              onClick={() => send({ type: MsgStop, text: "" })}
            >
              정지 (Esc)
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                className="flex max-w-[18rem] items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-800"
                title={role ? `${role.provider}/${role.model}` : currentModel}
                onClick={() => {
                  if (modelMenuOpen) {
                    setModelMenuOpen(false);
                    return;
                  }
                  openModelMenu();
                }}
              >
                <span className="text-neutral-500">모델</span>
                <span className="truncate text-neutral-200">{currentModel}</span>
                <span className="text-neutral-500">▾</span>
              </button>
              {modelMenuOpen && (
                <div className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded border border-neutral-700 bg-neutral-950 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1.5">
                    <span className="text-xs font-medium text-neutral-300">모델 선택</span>
                    <button
                      className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
                      disabled={modelsLoading}
                      onClick={() => void loadModels(true)}
                    >
                      새로고침
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto p-1">
                    {modelsLoading && <div className="px-2 py-2 text-xs text-neutral-500">모델 불러오는 중…</div>}
                    {!modelsLoading && modelGroups.length === 0 && (
                      <div className="px-2 py-2 text-xs text-neutral-500">사용 가능한 모델이 없습니다.</div>
                    )}
                    {modelGroups.map((group) => (
                      <div key={group.provider} className="mb-1 last:mb-0">
                        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">{group.provider}</div>
                        {group.error ? (
                          <div className="break-words px-2 py-1 text-[11px] text-red-400">{group.error}</div>
                        ) : group.models.length === 0 ? (
                          <div className="px-2 py-1 text-[11px] text-neutral-600">모델 없음</div>
                        ) : (
                          group.models.map((model) => {
                            const active = role?.provider === group.provider && role.model === model;
                            return (
                              <button
                                key={group.provider + "/" + model}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${active ? "bg-emerald-900/40 text-emerald-300" : "text-neutral-300 hover:bg-neutral-800"}`}
                                title={`${group.provider}/${model}`}
                                onClick={() => void chooseModel(group.provider, model)}
                              >
                                <span className="min-w-0 flex-1 truncate">{model}</span>
                                {active && <span className="shrink-0">✓</span>}
                              </button>
                            );
                          })
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                className="flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-800"
                onClick={() => {
                  if (thinkMenuOpen) {
                    setThinkMenuOpen(false);
                    return;
                  }
                  setThinkMenuOpen(true);
                  setModelMenuOpen(false);
                }}
              >
                <span className="text-neutral-500">think</span>
                <span className="text-neutral-200">{currentThink}</span>
                <span className="text-neutral-500">▾</span>
              </button>
              {thinkMenuOpen && (
                <div className="absolute bottom-full right-0 z-30 mb-2 w-48 overflow-hidden rounded border border-neutral-700 bg-neutral-950 shadow-2xl">
                  <div className="border-b border-neutral-800 px-2 py-1.5 text-xs font-medium text-neutral-300">추론 레벨</div>
                  <div className="p-1">
                    {THINK_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${currentThink === level ? "bg-emerald-900/40 text-emerald-300" : "text-neutral-300 hover:bg-neutral-800"}`}
                        onClick={() => pickThink(level)}
                      >
                        <span className="flex-1">{level}{level === "auto" ? " (기본)" : ""}</span>
                        {currentThink === level && <span>✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className="relative flex-1 rounded border border-neutral-700 bg-neutral-900 focus-within:border-neutral-500">
            {draftHint && (
              <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre px-3 py-2 text-sm leading-6 text-neutral-600">
                <span className="invisible">{draftHint.text.startsWith(" ") ? draft.trimEnd() : draft}</span>
                <span>{draftHint.text}</span>
              </div>
            )}
            <textarea
              ref={taRef}
              className="relative z-10 block max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 outline-none"
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
          </div>
          <button
            className="rounded bg-emerald-800 px-4 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-40"
            disabled={draft.trim() === "" || (busy && !parseSlashCommand(draft)?.spec?.runWhileBusy)}
            onClick={onSubmit}
          >
            전송
          </button>
        </div>
      </div>

      {showAdmin && <Admin onClose={() => setShowAdmin(false)} />}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
