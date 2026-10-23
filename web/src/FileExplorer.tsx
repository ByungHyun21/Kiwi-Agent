import { useEffect, useState } from "react";
import type { DirEntry } from "../../src/shared/protocol";

interface FileExplorerProps {
  workdir: string;
  sessionKey: string;
  entries: Record<string, DirEntry[]>;
  errors: Record<string, string>;
  onLoad: (path: string) => void;
}

interface FileBadge {
  label: string;
  className: string;
}

// Add new extensions here. Unknown files fall back to the plain document icon.
const FILE_BADGES: Record<string, FileBadge> = {
  ts: { label: "TS", className: "bg-[#3178c6] text-white" },
  tsx: { label: "TS", className: "bg-[#3178c6] text-white" },
  js: { label: "JS", className: "bg-[#f7df1e] text-black" },
  jsx: { label: "JS", className: "bg-[#f7df1e] text-black" },
  mjs: { label: "JS", className: "bg-[#f7df1e] text-black" },
  cjs: { label: "JS", className: "bg-[#f7df1e] text-black" },
  py: { label: "PY", className: "bg-[#3776ab] text-white" },
  json: { label: "{}", className: "bg-[#b07d3b] text-white" },
  md: { label: "M", className: "bg-[#5b6670] text-white" },
  mdx: { label: "M", className: "bg-[#5b6670] text-white" },
  css: { label: "#", className: "bg-[#663399] text-white" },
  scss: { label: "#", className: "bg-[#c6538c] text-white" },
  sass: { label: "#", className: "bg-[#c6538c] text-white" },
  less: { label: "#", className: "bg-[#2d5f9a] text-white" },
  html: { label: "<>", className: "bg-[#e34c26] text-white" },
  htm: { label: "<>", className: "bg-[#e34c26] text-white" },
  xml: { label: "<>", className: "bg-[#e37933] text-white" },
  yml: { label: "Y", className: "bg-[#7b8491] text-white" },
  yaml: { label: "Y", className: "bg-[#7b8491] text-white" },
  sh: { label: ">_", className: "bg-[#2f6f3e] text-white" },
  bash: { label: ">_", className: "bg-[#2f6f3e] text-white" },
  zsh: { label: ">_", className: "bg-[#2f6f3e] text-white" },
  toml: { label: "TO", className: "bg-[#9c4221] text-white" },
  csv: { label: "CSV", className: "bg-[#2e7d32] text-white" },
  env: { label: "EN", className: "bg-[#4f7a4a] text-white" },
  png: { label: "IMG", className: "bg-[#7c3aed] text-white" },
  jpg: { label: "IMG", className: "bg-[#7c3aed] text-white" },
  jpeg: { label: "IMG", className: "bg-[#7c3aed] text-white" },
  gif: { label: "IMG", className: "bg-[#7c3aed] text-white" },
  webp: { label: "IMG", className: "bg-[#7c3aed] text-white" },
  svg: { label: "SVG", className: "bg-[#c084fc] text-black" },
};

const SPECIAL_BADGES: Record<string, FileBadge> = {
  dockerfile: { label: "DK", className: "bg-[#2496ed] text-white" },
  makefile: { label: "MK", className: "bg-[#c98a3d] text-white" },
};

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

function FileIcon({ name }: { name: string }): React.ReactElement {
  const ext = extensionOf(name);
  const badge = FILE_BADGES[ext] ?? SPECIAL_BADGES[ext];
  if (badge) {
    return (
      <span
        className={`flex h-3.5 w-4 shrink-0 items-center justify-center rounded-[2px] text-[7px] font-bold leading-none ${badge.className}`}
        aria-hidden="true"
      >
        {badge.label}
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-neutral-200"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function FolderIcon({ className = "" }: { className?: string }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
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
  const [collapsed, setCollapsed] = useState(false);

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
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[#d7b36a]" />
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
          <span className="w-3 shrink-0" />
          <FileIcon name={entry.name} />
          <span className="truncate">{entry.name}</span>
        </div>
      );
    });
  };

  return (
    <aside
      className={[
        "hidden shrink-0 flex-col border-r border-neutral-800 bg-[#0b0f0c] transition-[width] duration-150 md:flex",
        collapsed ? "w-10" : "w-64",
      ].join(" ")}
    >
      {collapsed ? (
        <div className="flex justify-center py-2">
          <button
            type="button"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
            title="파일 탐색기 펼치기"
            onClick={() => setCollapsed(false)}
          >
            <FolderIcon className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <>
          <div className="border-b border-neutral-800 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">Files</div>
                <div className="mt-1 truncate text-xs text-neutral-400" title={workdir}>
                  {workdir || "세션을 선택하세요"}
                </div>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                title="파일 탐색기 접기"
                onClick={() => setCollapsed(true)}
              >
                <span className="text-sm">‹</span>
              </button>
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
        </>
      )}
    </aside>
  );
}
