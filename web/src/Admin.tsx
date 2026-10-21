import { useCallback, useEffect, useState } from "react";
import type { ExecResult, Machine } from "../../src/shared/protocol";
import { api, errMsg } from "./api";

const input = "rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500";
const btn = "rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40";
const btnPrimary = "rounded bg-emerald-800 px-3 py-1 text-xs font-medium hover:bg-emerald-700 disabled:opacity-40";

interface Role {
  role: string;
  provider: string;
  model: string;
}

/** Admin is the machines + routing screen (replaces the legacy htmx pages). */
export default function Admin({ token, onClose }: { token: string; onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<"machines" | "settings">("machines");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [roleDraft, setRoleDraft] = useState({ provider: "", model: "" });
  const [form, setForm] = useState({ name: "", host: "", port: "22", user: "", execPath: "" });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reset = (): void => {
    setNotice("");
    setError("");
  };

  const loadMachines = useCallback(async (): Promise<void> => {
    try {
      setMachines(await api<Machine[]>("/api/machines", token));
    } catch (err) {
      setError(errMsg(err));
    }
  }, [token]);

  const loadRole = useCallback(async (): Promise<void> => {
    try {
      const r = await api<Role>("/api/roles/agent-chat", token);
      setRole(r);
      setRoleDraft({ provider: r.provider, model: r.model });
    } catch (err) {
      setError(errMsg(err));
    }
  }, [token]);

  useEffect(() => {
    void loadMachines();
    void loadRole();
  }, [loadMachines, loadRole]);

  async function addMachine(): Promise<void> {
    reset();
    const body = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port) || 22,
      user: form.user.trim(),
      ...(form.execPath.trim() !== "" ? { execPath: form.execPath.trim() } : {}),
    };
    if (body.name === "" || body.host === "" || body.user === "") {
      setError("이름, 호스트, 사용자가 필요합니다");
      return;
    }
    setBusy("add");
    try {
      await api<Machine>("/api/machines", token, { method: "POST", body: JSON.stringify(body) });
      setForm({ name: "", host: "", port: "22", user: "", execPath: "" });
      setNotice(`${body.name} 등록됨`);
      await loadMachines();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function updateMachine(m: Machine): Promise<void> {
    reset();
    setBusy(m.name);
    try {
      const res = await api<ExecResult>(`/api/machines/${encodeURIComponent(m.name)}/update`, token, { method: "POST" });
      if (!res.ok) throw new Error(res.message ?? res.code ?? "업데이트 실패");
      let info: { status?: string; version?: string } | null = null;
      try {
        info = res.data ? (JSON.parse(res.data) as { status?: string; version?: string }) : null;
      } catch {
        // non-JSON data is still a success
      }
      setNotice(`${m.name}: ${info?.status ?? "ok"}${info?.version ? " → " + info.version : ""}`);
      await loadMachines();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function removeMachine(m: Machine): Promise<void> {
    if (!window.confirm(`${m.name} 기기를 삭제할까요? (원격 폴더는 그대로 남습니다)`)) return;
    reset();
    setBusy(m.name);
    try {
      await api<void>(`/api/machines/${encodeURIComponent(m.name)}`, token, { method: "DELETE" });
      setNotice(`${m.name} 삭제됨`);
      await loadMachines();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function saveRole(): Promise<void> {
    reset();
    const provider = roleDraft.provider.trim();
    const model = roleDraft.model.trim();
    if (provider === "" || model === "") {
      setError("공급자와 모델이 필요합니다");
      return;
    }
    setBusy("role");
    try {
      await api<Role>("/api/roles/agent-chat", token, { method: "PUT", body: JSON.stringify({ provider, model }) });
      setNotice("역할 저장됨");
      await loadRole();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d1117]">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="rounded bg-[#3c5e20] px-2 py-0.5 text-sm font-bold text-white">KIWI</span>
        <span className="text-sm font-semibold">관리</span>
        <div className="ml-auto flex items-center gap-1">
          <button className={tab === "machines" ? btnPrimary : btn} onClick={() => setTab("machines")}>
            기기
          </button>
          <button className={tab === "settings" ? btnPrimary : btn} onClick={() => setTab("settings")}>
            설정
          </button>
          <button className={btn + " ml-2"} onClick={onClose}>
            닫기
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {(notice !== "" || error !== "") && (
          <div className={`mb-3 text-xs ${error !== "" ? "text-[#d98a4a]" : "text-[#8fce5a]"}`}>{error !== "" ? error : notice}</div>
        )}

        {tab === "machines" ? (
          <div className="space-y-4">
            <section>
              <h2 className="mb-2 text-sm font-semibold">등록된 기기</h2>
              {machines.length === 0 ? (
                <p className="text-xs text-neutral-500">등록된 기기가 없습니다. 아래에서 SSH로 접속할 작업 PC를 추가하세요.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-neutral-500">
                    <tr>
                      <th className="pb-1 pr-3 font-normal">이름</th>
                      <th className="pb-1 pr-3 font-normal">호스트</th>
                      <th className="pb-1 pr-3 font-normal">상태</th>
                      <th className="pb-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {machines.map((m) => (
                      <tr key={m.name} className="border-t border-neutral-800 align-top">
                        <td className="py-1 pr-3">{m.name}</td>
                        <td className="py-1 pr-3 font-mono text-xs text-neutral-400">
                          {m.user}@{m.host}:{m.port}
                        </td>
                        <td className="py-1 pr-3 text-xs">
                          {m.state}
                          {m.execPath ? <span className="block text-neutral-600">{m.execPath}</span> : null}
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">
                          <button className={btn} disabled={busy !== ""} onClick={() => void updateMachine(m)}>
                            업데이트
                          </button>
                          <button className={btn + " ml-1"} disabled={busy !== ""} onClick={() => void removeMachine(m)}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold">기기 추가</h2>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-neutral-400">
                  이름
                  <input className={input + " mt-0.5 block w-28"} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label className="text-xs text-neutral-400">
                  호스트
                  <input className={input + " mt-0.5 block w-40"} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                </label>
                <label className="text-xs text-neutral-400">
                  포트
                  <input className={input + " mt-0.5 block w-20"} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </label>
                <label className="text-xs text-neutral-400">
                  사용자
                  <input className={input + " mt-0.5 block w-28"} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
                </label>
                <label className="text-xs text-neutral-400">
                  exec 경로 (선택)
                  <input
                    className={input + " mt-0.5 block w-56"}
                    placeholder="~/.local/bin/kiwi"
                    value={form.execPath}
                    onChange={(e) => setForm({ ...form, execPath: e.target.value })}
                  />
                </label>
                <button className={btnPrimary} disabled={busy !== ""} onClick={() => void addMachine()}>
                  추가
                </button>
              </div>
              <p className="mt-1 text-xs text-neutral-600">서버 → 작업 PC는 키 기반 SSH여야 합니다 (BatchMode).</p>
            </section>
          </div>
        ) : (
          <div className="space-y-4">
            <section>
              <h2 className="mb-2 text-sm font-semibold">역할 라우팅</h2>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-neutral-400">
                  역할
                  <div className="mono mt-0.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm">agent-chat</div>
                </label>
                <label className="text-xs text-neutral-400">
                  공급자
                  <input className={input + " mt-0.5 block w-32"} value={roleDraft.provider} onChange={(e) => setRoleDraft({ ...roleDraft, provider: e.target.value })} />
                </label>
                <label className="text-xs text-neutral-400">
                  모델
                  <input className={input + " mt-0.5 block w-56"} value={roleDraft.model} onChange={(e) => setRoleDraft({ ...roleDraft, model: e.target.value })} />
                </label>
                <button className={btnPrimary} disabled={busy !== "" || role === null} onClick={() => void saveRole()}>
                  저장
                </button>
              </div>
              {role === null && <p className="mt-1 text-xs text-neutral-600">역할이 아직 설정되지 않았습니다.</p>}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold">접근 토큰</h2>
              <code className="block break-all rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-400">{token}</code>
              <p className="mt-1 text-xs text-neutral-600">
                KIWI_AUTH=off(기본)에서는 인증 없이 접근합니다. on이면 이 토큰이 필요합니다.
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
