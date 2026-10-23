import { useEffect, useState } from "react";

/** Thinking is the collapsible reasoning trace shown above an answer. */
export default function Thinking({ text, live = false }: { text: string; live?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(live);

  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  return (
    <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-950/50">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-500 transition-colors hover:bg-neutral-900/70"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <span className="font-medium text-neutral-400">Thinking</span>
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a8c17a]" />}
        <span className="ml-auto text-[10px] text-neutral-600">{open ? "접기" : "펼치기"}</span>
      </button>
      {open ? (
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-[#8b978a]">
          {text}
        </div>
      ) : text !== "" ? (
        <div className="line-clamp-2 whitespace-pre-wrap break-words border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-[#8b978a]">
          {text}
        </div>
      ) : null}
    </div>
  );
}
