import { useCallback, useEffect, useState } from "react";
import type { ExecResult, Machine, ProviderInfo, ProviderModelGroup } from "../../src/shared/protocol";
import { api, errMsg } from "./api";

const input = "rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500";
const btn = "rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40";
const btnPrimary = "rounded bg-emerald-800 px-3 py-1 text-xs font-medium hover:bg-emerald-700 disabled:opacity-40";

interface Role {
  role: string;
  provider: string;
  model: string;
}

interface SearchSettings {
  url: string;
  source: "web" | "env" | "none";
}

interface SearchTest {
  ok: boolean;
  message: string;
  results?: number;
}

/** Admin is the machines + routing + search screen (replaces the legacy htmx pages). */
export default function Admin({ onClose }: { onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<"machines" | "search" | "settings">("machines");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [modelGroups, setModelGroups] = useState<ProviderModelGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [roleDraft, setRoleDraft] = useState({ provider: "", model: "" });
  const [searchSettings, setSearchSettings] = useState<SearchSettings | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchTest, setSearchTest] = useState<SearchTest | null>(null);
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
      setMachines(await api<Machine[]>("/api/machines"));
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      setProviders(await api<ProviderInfo[]>("/api/providers"));
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  const loadRole = useCallback(async (): Promise<void> => {
    try {
      const r = await api<Role>("/api/roles/agent-chat");
      setRole(r);
      setRoleDraft({ provider: r.provider, model: r.model });
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  const loadModels = useCallback(async (refresh: boolean): Promise<void> => {
    setModelsLoading(true);
    try {
      const groups = await api<ProviderModelGroup[]>(`/api/models?all=1${refresh ? "&refresh=1" : ""}`);
      setModelGroups(groups);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadSearch = useCallback(async (): Promise<void> => {
    try {
      const r = await api<SearchSettings>("/api/settings/search");
      setSearchSettings(r);
      setSearchDraft(r.url);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void loadMachines();
    void loadProviders();
    void loadRole();
    void loadSearch();
  }, [loadMachines, loadProviders, loadRole, loadSearch]);

  useEffect(() => {
    if (tab === "settings") void loadModels(false);
  }, [tab, loadModels]);

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
      await api<Machine>("/api/machines", { method: "POST", body: JSON.stringify(body) });
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
      const res = await api<ExecResult>(`/api/machines/${encodeURIComponent(m.name)}/update`, { method: "POST" });
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

  async function pinMachine(m: Machine, force: boolean): Promise<void> {
    if (force && !window.confirm(`${m.name}의 호스트 키를 현재 키로 다시 고정할까요?`)) return;
    reset();
    setBusy(m.name);
    try {
      const res = await api<ExecResult>(`/api/machines/${encodeURIComponent(m.name)}/pin`, {
        method: "POST",
        ...(force ? { body: JSON.stringify({ force: true }) } : {}),
      });
      if (!res.ok) throw new Error(res.message ?? res.code ?? "호스트 키 고정 실패");
      let info: { fingerprint?: string } | null = null;
      try {
        info = res.data ? (JSON.parse(res.data) as { fingerprint?: string }) : null;
      } catch {
        // non-JSON data is still a success
      }
      setNotice(`${m.name}: ${info?.fingerprint ?? "호스트 키 고정됨"}`);
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
      await api<void>(`/api/machines/${encodeURIComponent(m.name)}`, { method: "DELETE" });
      setNotice(`${m.name} 삭제됨`);
      await loadMachines();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  function startEditProvider(provider: ProviderInfo): void {
    reset();
    setEditingProvider(provider.name);
    setProviderForm({ name: provider.name, baseUrl: provider.baseUrl, apiKey: "" });
  }

  function cancelEditProvider(): void {
    setEditingProvider(null);
    setProviderForm({ name: "", baseUrl: "", apiKey: "" });
  }

  async function saveProvider(): Promise<void> {
    reset();
    const name = providerForm.name.trim();
    const baseUrl = providerForm.baseUrl.trim();
    if (name === "" || baseUrl === "") {
      setError("이름과 base URL이 필요합니다");
      return;
    }
    setBusy("provider");
    try {
      const body = editingProvider
        ? {
            name,
            baseUrl,
            ...(providerForm.apiKey.trim() !== "" ? { apiKey: providerForm.apiKey } : {}),
          }
        : { name, baseUrl, apiKey: providerForm.apiKey };
      const saved = await api<ProviderInfo>(
        editingProvider ? `/api/providers/${encodeURIComponent(editingProvider)}` : "/api/providers",
        {
          method: editingProvider ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      const wasEditing = editingProvider !== null;
      setEditingProvider(null);
      setProviderForm({ name: "", baseUrl: "", apiKey: "" });
      setNotice(`${saved.name} 공급자 ${wasEditing ? "수정됨" : "등록됨"}`);
      await loadProviders();
      await loadRole();
      if (!wasEditing && roleDraft.provider === "") setRoleDraft({ provider: saved.name, model: "" });
      void loadModels(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function removeProvider(provider: ProviderInfo): Promise<void> {
    if (!window.confirm(`${provider.name} 공급자를 삭제할까요?`)) return;
    reset();
    setBusy("provider-delete");
    try {
      await api<void>(`/api/providers/${encodeURIComponent(provider.name)}`, { method: "DELETE" });
      if (editingProvider === provider.name) cancelEditProvider();
      if (roleDraft.provider === provider.name) setRoleDraft({ provider: "", model: "" });
      setNotice(`${provider.name} 공급자 삭제됨`);
      await loadProviders();
      await loadRole();
      void loadModels(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function refreshModels(): Promise<void> {
    reset();
    await loadModels(true);
    setNotice("모델 목록을 새로고침했습니다");
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
      await api<Role>("/api/roles/agent-chat", { method: "PUT", body: JSON.stringify({ provider, model }) });
      setNotice("역할 저장됨");
      await loadRole();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function saveSearch(): Promise<void> {
    reset();
    setBusy("search");
    try {
      const r = await api<SearchSettings>("/api/settings/search", {
        method: "PUT",
        body: JSON.stringify({ url: searchDraft }),
      });
      setSearchSettings(r);
      setSearchDraft(r.url);
      setSearchTest(null);
      setNotice("검색엔진 주소 저장됨");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  async function testSearch(): Promise<void> {
    reset();
    setBusy("search-test");
    setSearchTest(null);
    try {
      const r = await api<SearchTest>("/api/settings/search/test", {
        method: "POST",
        body: JSON.stringify({ url: searchDraft }),
      });
      setSearchTest(r);
      if (!r.ok) setError(r.message);
      else setNotice(r.message);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy("");
    }
  }

  const searchSourceLabel = (source: SearchSettings["source"]): string => {
    if (source === "web") return "웹 설정";
    if (source === "env") return "SEARXNG_URL 환경변수";
    return "미설정";
  };

  const providerNames = providers.map((provider) => provider.name);
  if (roleDraft.provider !== "" && !providerNames.includes(roleDraft.provider)) {
    providerNames.unshift(roleDraft.provider);
  }
  const roleModels = modelGroups.find((group) => group.provider === roleDraft.provider)?.models ?? [];
  const modelOptions =
    roleDraft.model !== "" && !roleModels.includes(roleDraft.model) ? [roleDraft.model, ...roleModels] : roleModels;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d1117]">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="rounded bg-[#3c5e20] px-2 py-0.5 text-sm font-bold text-white">KIWI</span>
        <span className="text-sm font-semibold">관리</span>
        <div className="ml-auto flex items-center gap-1">
          <button className={tab === "machines" ? btnPrimary : btn} onClick={() => setTab("machines")}>
            기기
          </button>
          <button className={tab === "search" ? btnPrimary : btn} onClick={() => setTab("search")}>
            검색엔진
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
                          {m.hostKey ? (
                            <span className="block break-all font-mono text-[10px] text-neutral-500">{m.hostKey}</span>
                          ) : (
                            <span className="block text-[10px] text-[#d98a4a]">호스트 키 미고정</span>
                          )}
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">
                          <button className={btn} disabled={busy !== ""} onClick={() => void pinMachine(m, false)}>
                            {m.hostKey ? "키 확인" : "키 고정"}
                          </button>
                          {m.hostKey ? (
                            <button className={btn + " ml-1"} disabled={busy !== ""} onClick={() => void pinMachine(m, true)}>
                              재고정
                            </button>
                          ) : null}
                          <button className={btn + " ml-1"} disabled={busy !== ""} onClick={() => void updateMachine(m)}>
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
        ) : tab === "search" ? (
          <div className="space-y-4">
            <section>
              <h2 className="mb-2 text-sm font-semibold">검색엔진 (SearXNG)</h2>
              <p className="mb-2 text-xs text-neutral-500">
                에이전트의 web_search가 사용할 SearXNG JSON API 주소입니다. 저장하면 다음 검색부터 바로 적용됩니다.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-neutral-400">
                  주소
                  <input
                    className={input + " mt-0.5 block w-[30rem] max-w-full"}
                    placeholder="http://127.0.0.1:8888"
                    value={searchDraft}
                    onChange={(e) => {
                      setSearchDraft(e.target.value);
                      setSearchTest(null);
                    }}
                  />
                </label>
                <button className={btnPrimary} disabled={busy !== ""} onClick={() => void saveSearch()}>
                  저장
                </button>
                <button className={btn} disabled={busy !== ""} onClick={() => void testSearch()}>
                  연결 테스트
                </button>
              </div>
              {searchSettings ? (
                <p className="mt-2 text-xs text-neutral-500">
                  현재 적용:{" "}
                  <code className="text-neutral-300">{searchSettings.url || "미설정"}</code>{" "}
                  <span className="text-neutral-600">({searchSourceLabel(searchSettings.source)})</span>
                </p>
              ) : null}
              {searchTest ? (
                <p className={`mt-1 text-xs ${searchTest.ok ? "text-[#8fce5a]" : "text-[#d98a4a]"}`}>{searchTest.message}</p>
              ) : null}
              <p className="mt-2 text-xs text-neutral-600">
                SearXNG 설정에서 search.formats에 <code>json</code>이 포함되어 있어야 합니다. 주소를 비우고 저장하면
                SEARXNG_URL 환경변수로 돌아갑니다.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold">직접 띄우기 (선택)</h2>
              <p className="text-xs text-neutral-500">
                Docker를 쓰지 않는 경우 이미 돌고 있는 SearXNG 주소를 위에 입력하세요. 필요하면 저장소의 선택 폴더로
                로컬 SearXNG를 띄울 수 있습니다.
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
{`cd option/searxng
docker compose up -d`}
              </pre>
              <p className="mt-1 text-xs text-neutral-600">
                기본 주소는 <code>http://127.0.0.1:8888</code>입니다. 다른 PC에서 띄웠다면 그 PC의 주소를 입력하세요.
              </p>
            </section>
          </div>
        ) : (
          <div className="space-y-5">
            <section>
              <h2 className="mb-2 text-sm font-semibold">
                {editingProvider ? `프로바이더 수정: ${editingProvider}` : "프로바이더 추가"}
              </h2>
              <p className="mb-2 text-xs text-neutral-500">
                OpenAI 호환 엔드포인트를 등록합니다. base URL은 보통 <code>/v1</code>까지 포함합니다.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-neutral-400">
                  이름
                  <input
                    className={input + " mt-0.5 block w-32"}
                    placeholder="local"
                    value={providerForm.name}
                    onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                  />
                </label>
                <label className="text-xs text-neutral-400">
                  Base URL
                  <input
                    className={input + " mt-0.5 block w-[26rem] max-w-full"}
                    placeholder="http://192.168.0.36:5300/v1"
                    value={providerForm.baseUrl}
                    onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                  />
                </label>
                <label className="text-xs text-neutral-400">
                  API key (선택)
                  <input
                    type="password"
                    autoComplete="off"
                    className={input + " mt-0.5 block w-56 max-w-full"}
                    placeholder={editingProvider ? "변경할 때만 입력 (기존 키 유지)" : "없으면 비워두세요"}
                    value={providerForm.apiKey}
                    onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                  />
                </label>
                <button className={btnPrimary} disabled={busy !== ""} onClick={() => void saveProvider()}>
                  {editingProvider ? "저장" : "추가"}
                </button>
                {editingProvider ? (
                  <button className={btn} disabled={busy !== ""} onClick={cancelEditProvider}>
                    취소
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-neutral-600">
                {editingProvider
                  ? "이름을 바꾸면 이 공급자를 사용하는 역할 라우팅도 함께 갱신됩니다. API key를 비우면 기존 키를 유지합니다."
                  : "같은 이름으로 다시 추가하면 base URL과 API key가 갱신됩니다."}
              </p>

              {providers.length > 0 ? (
                <div className="mt-3 divide-y divide-neutral-800 rounded border border-neutral-800">
                  {providers.map((provider) => (
                    <div key={provider.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <span className="w-28 shrink-0 font-medium text-neutral-200">{provider.name}</span>
                      <code className="min-w-0 flex-1 truncate text-neutral-400">{provider.baseUrl}</code>
                      <span className={provider.hasApiKey ? "text-[#8fce5a]" : "text-neutral-600"}>
                        {provider.hasApiKey ? "key 설정됨" : "key 없음"}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button className={btn} disabled={busy !== ""} onClick={() => startEditProvider(provider)}>
                          수정
                        </button>
                        <button
                          className={btn + " hover:text-[#d98a4a]"}
                          disabled={busy !== ""}
                          onClick={() => void removeProvider(provider)}
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-neutral-600">등록된 프로바이더가 없습니다.</p>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold">역할 라우팅</h2>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-neutral-400">
                  역할
                  <div className="mono mt-0.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm">agent-chat</div>
                </label>
                <label className="text-xs text-neutral-400">
                  공급자
                  <select
                    className={input + " mt-0.5 block w-40"}
                    value={roleDraft.provider}
                    onChange={(e) => {
                      const provider = e.target.value;
                      const models = modelGroups.find((group) => group.provider === provider)?.models ?? [];
                      setRoleDraft({ provider, model: models[0] ?? "" });
                    }}
                  >
                    <option value="">공급자 선택</option>
                    {providerNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-neutral-400">
                  모델
                  <select
                    className={input + " mt-0.5 block w-72"}
                    value={roleDraft.model}
                    disabled={modelOptions.length === 0}
                    onChange={(e) => setRoleDraft({ ...roleDraft, model: e.target.value })}
                  >
                    <option value="">모델 선택</option>
                    {modelOptions.map((model) => (
                      <option key={model} value={model}>
                        {roleDraft.provider ? `${roleDraft.provider}/${model}` : model}
                      </option>
                    ))}
                  </select>
                </label>
                <button className={btnPrimary} disabled={busy !== "" || role === null} onClick={() => void saveRole()}>
                  저장
                </button>
              </div>
              {role === null && <p className="mt-1 text-xs text-neutral-600">역할이 아직 설정되지 않았습니다.</p>}
              {roleModels.length === 0 && roleDraft.provider !== "" && (
                <p className="mt-1 text-xs text-neutral-600">모델 목록이 없습니다. 아래에서 새로고침하세요.</p>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">인식된 모델</h2>
                <button className={btn} disabled={modelsLoading} onClick={() => void refreshModels()}>
                  {modelsLoading ? "조회 중…" : "새로고침"}
                </button>
              </div>
              <p className="mb-2 text-xs text-neutral-500">
                등록된 모든 프로바이더의 <code>/models</code>를 조회합니다. 모델을 클릭하면 위 역할 라우팅에 선택됩니다.
              </p>
              {modelGroups.length === 0 ? (
                <p className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-600">
                  아직 조회된 모델이 없습니다. 새로고침을 눌러주세요.
                </p>
              ) : (
                <div className="space-y-3">
                  {modelGroups.map((group) => (
                    <div key={group.provider} className="overflow-hidden rounded border border-neutral-800">
                      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-900/60 px-3 py-2">
                        <span className="text-xs font-medium text-neutral-200">{group.provider}</span>
                        <span className="text-[10px] text-neutral-500">{group.models.length}개</span>
                      </div>
                      {group.error ? (
                        <p className="px-3 py-2 text-xs text-[#d98a4a]">{group.error}</p>
                      ) : group.models.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-neutral-600">모델 없음</p>
                      ) : (
                        <div className="divide-y divide-neutral-800">
                          {group.models.map((model) => {
                            const selected = roleDraft.provider === group.provider && roleDraft.model === model;
                            return (
                              <button
                                key={model}
                                type="button"
                                onClick={() => setRoleDraft({ provider: group.provider, model })}
                                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                                  selected
                                    ? "bg-emerald-950/40 text-emerald-300"
                                    : "text-neutral-300 hover:bg-neutral-900"
                                }`}
                              >
                                <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
                                {selected ? <span className="text-[10px] text-emerald-400">선택됨</span> : null}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
