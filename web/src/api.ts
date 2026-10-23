// HTTP/WS plumbing for the kiwi-server API. Wire contracts (event names,
// message types, payload shapes) live in src/shared/protocol.ts.

/** wsURL builds ws://<current host>/ws for this page. */
export function wsURL(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/** api calls the server; non-2xx bodies become errors. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, { ...init, headers });
  if (!resp.ok) {
    const text = (await resp.text()).trim();
    throw new Error(text || `HTTP ${resp.status}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/** errMsg normalizes thrown values for display. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
