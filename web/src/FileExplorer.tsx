import { useEffect, useState } from "react";
import type { DirEntry } from "../../src/shared/protocol";

interface FileExplorerProps {
  workdir: string;
  sessionKey: string;
  entries: Record<string, DirEntry[]>;
  errors: Record<string, string>;
  onLoad: (path: string) => void;
}

/** FileExplorer is a read-only tree rooted at the session's execution folder. */
export default function FileExplorer({
  workdir,
  sessionKey,
  entries,
  errors,
  onLoad,
}: FileExplorerProps): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  useEffect(() => {
    setExpanded(new Set([""]));
  }, [workdir, sessionKey]);

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (entries[path] === undefined) onLoad(path);
      }
      return next;
    });
  };

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const list = entries[path];
    const error = errors[path];
    if (error) {
      return <div className="px-3 py-1 text-[11px] leading-relaxed text-red-400" style={{ paddingLeft: 10 + depth * 12 }}>{error}</div>;
    }
    if (list === undefined) {
      return <div className="px-3 py-1 text-[11px] text-neutral-600" style={{ paddingLeft: 10 + depth * 12 }}>불러오는 중…</div>;
    }
    if (list.length === 0) {
      return <div className="px-3 py-1 text-[11px] text-neutral-600" style={{ paddingLeft: 10 + depth * 12 }}>비어 있음</div>;
    }
    return list.map((entry) => {
      const child = path === "" ? entry.name : path + "/" + entry.name;
      if (entry.dir) {
        const open = expanded.has(child);
        return (
          <div key={child}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-neutral-300 hover:bg-neutral-900"
              style={{ paddingLeft: 8 + depth * 12 }}
              title={child}
              onClick={() => toggle(child)}
            >
              <span className="w-3 shrink-0 text-[10px] text-neutral-500">{open ? "▾" : "▸"}</span>
              <span className="truncate">{entry.name}</span>
            </button>
            {open && renderDir(child, depth + 1)}
          </div>
        );
      }
      return (
        <div
          key={child}
          className="flex items-center gap-1.5 py-1 pr-2 text-xs text-neutral-500"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={child}
        >
          <span className="w-3 shrink-0 text-center text-[11px] text-neutral-700">·</span>
          <span className="truncate">{entry.name}</span>
        </div>
      );
    });
  };

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-800 bg-[#0b0f0c] md:flex">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">Files</div>
        <div className="mt-1 truncate text-xs text-neutral-400" title={workdir}>
          {workdir || "세션을 선택하세요"}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {workdir === "" ? (
          <div className="px-3 py-2 text-[11px] leading-relaxed text-neutral-600">
            세션을 선택하면 현재 실행 위치의 폴더가 표시됩니다.
          </div>
        ) : (
          renderDir("", 0)
        )}
      </div>
    </aside>
  );
}
