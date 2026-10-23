import { useState } from "react";
import type { ReactElement } from "react";

type IconName =
  | "home"
  | "layers"
  | "check"
  | "calendar"
  | "message"
  | "settings"
  | "file"
  | "image"
  | "video"
  | "music"
  | "chevron-down"
  | "command"
  | "plus"
  | "alert"
  | "panel-close"
  | "panel-open"
  | "sparkles";

function Icon({ name, className = "" }: { name: IconName; className?: string }): ReactElement {
  const classes = ["h-4 w-4 shrink-0", className].filter(Boolean).join(" ");
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common} className={classes}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
          <path d="M9 21v-6h6v6" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common} className={classes}>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 16 9 5 9-5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="m7.5 12 3 3 6-6" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
      );
    case "message":
      return (
        <svg {...common} className={classes}>
          <path d="M21 12a8 8 0 0 1-8 8H6l-3 2v-6a8 8 0 1 1 18-4Z" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common} className={classes}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.4.55.75 1 .95.3.12.65.15 1 .1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1Z" />
        </svg>
      );
    case "file":
      return (
        <svg {...common} className={classes}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6M8 13h8M8 17h6" />
        </svg>
      );
    case "image":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      );
    case "video":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="5" width="14" height="14" rx="3" />
          <path d="m17 10 4-2v8l-4-2" />
        </svg>
      );
    case "music":
      return (
        <svg {...common} className={classes}>
          <path d="M9 18V5l10-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common} className={classes}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "command":
      return (
        <svg {...common} className={classes}>
          <path d="M9 6a3 3 0 1 0-3 3h3V6Zm0 0v12m6-12v12m0-12a3 3 0 1 1 3 3h-3V6ZM9 18a3 3 0 1 1-3-3h3v3Zm6 0a3 3 0 1 0 3-3h-3v3Z" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common} className={classes}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common} className={classes}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 17h.01" />
        </svg>
      );
    case "panel-close":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M9 4v16M15 9l-3 3 3 3" />
        </svg>
      );
    case "panel-open":
      return (
        <svg {...common} className={classes}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M9 4v16M12 9l3 3-3 3" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common} className={classes}>
          <path d="m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3L7.5 7.5l3.3-1.2L12 3Z" />
          <path d="m18 13 .8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13ZM6 14l.6 1.6L8 16l-1.4.4L6 18l-.6-1.6L4 16l1.4-.4L6 14Z" />
        </svg>
      );
  }
}

const OUTPUTS = [
  { id: "text", label: "Text / Code", hint: "코드, 문서, 로그", icon: "file" },
  { id: "image", label: "Images", hint: "아트, UI, 텍스처", icon: "image" },
  { id: "video", label: "Video", hint: "트레일러, 컷신", icon: "video" },
  { id: "audio", label: "Audio", hint: "SFX, 음악, 보이스", icon: "music" },
] as const;

const WORKSTREAMS = [
  { id: "design", label: "Design", hint: "기획, UX, 콘텐츠" },
  { id: "build", label: "Build", hint: "코드, 빌드, 테스트" },
  { id: "art", label: "Art", hint: "이미지, 애니메이션" },
  { id: "audio", label: "Audio", hint: "사운드, 음악" },
  { id: "qa", label: "QA", hint: "버그, 호환성" },
] as const;

const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

function weekDays(): Date[] {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return day;
  });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function SectionHeader({ title, note }: { title: string; note?: string }): ReactElement {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b978a]">{title}</h2>
      {note ? <span className="text-[10px] text-[#5f6b5d]">{note}</span> : null}
    </div>
  );
}

function EmptyState({ icon, title, description }: { icon: IconName; title: string; description: string }): ReactElement {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-[#2c3a2c] bg-[#0e140f] p-5">
      <div className="mt-0.5 rounded-lg border border-[#2c3a2c] bg-[#111713] p-2 text-[#6f7d6c]">
        <Icon name={icon} />
      </div>
      <div>
        <p className="text-sm font-medium text-[#c9d2c4]">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-[#6f7d6c]">{description}</p>
      </div>
    </div>
  );
}

function OutputCard({ label, hint, icon }: { label: string; hint: string; icon: IconName }): ReactElement {
  return (
    <div
      className="rounded-xl border border-[#263128] bg-[#111713] p-4 opacity-80"
      title="데이터 소스가 연결되면 활성화됩니다"
      aria-disabled="true"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="rounded-lg border border-[#2c3a2c] bg-[#0e140f] p-2 text-[#7f8f78]">
          <Icon name={icon} />
        </span>
        <span className="rounded-full border border-[#2c3a2c] px-2 py-0.5 text-[9px] uppercase tracking-wide text-[#5f6b5d]">
          미연결
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight text-[#4b5748]">—</div>
      <div className="mt-1 text-sm font-medium text-[#c9d2c4]">{label}</div>
      <div className="mt-0.5 text-[11px] text-[#6f7d6c]">{hint}</div>
    </div>
  );
}

function WorkstreamCard({ label, hint }: { label: string; hint: string }): ReactElement {
  return (
    <div className="rounded-xl border border-[#263128] bg-[#111713] p-4 opacity-80" aria-disabled="true">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[#c9d2c4]">{label}</span>
        <span className="h-1.5 w-1.5 rounded-full bg-[#3a4538]" />
      </div>
      <div className="mt-4 text-lg font-semibold text-[#4b5748]">—</div>
      <div className="mt-0.5 text-[11px] text-[#6f7d6c]">{hint}</div>
      <div className="mt-3 text-[10px] uppercase tracking-wide text-[#4f5c4d]">데이터 없음</div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  disabled,
  collapsed,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  collapsed: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${label} · 아직 구현되지 않음` : label}
      aria-current={active ? "page" : undefined}
      className={[
        "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        collapsed ? "justify-center px-0" : "",
        disabled
          ? "cursor-not-allowed text-[#4f5c4d]"
          : active
            ? "bg-[#1a241b] text-[#e7ecdf]"
            : "text-[#8b978a] hover:bg-[#162018] hover:text-[#e7ecdf]",
      ].join(" ")}
    >
      {active ? <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[#9bcf5f]" /> : null}
      <Icon name={icon} />
      {!collapsed ? <span className="min-w-0 flex-1 text-left">{label}</span> : null}
      {!collapsed && disabled ? <span className="text-[9px] uppercase tracking-wide text-[#3f4a3d]">wip</span> : null}
    </button>
  );
}

export default function Home({
  onOpenChat,
  onOpenAdmin,
}: {
  onOpenChat: () => void;
  onOpenAdmin: () => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const days = weekDays();
  const today = new Date();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#0b0f0c] text-[#e7ecdf]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[#263128] px-3 md:px-4">
        <div className="flex items-center gap-2">
          <span className="rounded bg-[#3c5e20] px-2 py-1 text-xs font-bold tracking-wide text-white">KIWI</span>
          <span className="hidden text-sm font-semibold text-[#e7ecdf] sm:inline">Project Home</span>
        </div>
        <span className="hidden h-4 w-px bg-[#263128] sm:inline-block" />
        <button
          type="button"
          disabled
          title="프로젝트 데이터가 연결되면 선택할 수 있습니다"
          className="flex max-w-[220px] cursor-not-allowed items-center gap-2 rounded-md border border-[#263128] bg-[#111713] px-2.5 py-1.5 text-xs text-[#6f7d6c]"
        >
          <span className="truncate">프로젝트 선택</span>
          <Icon name="chevron-down" className="h-3.5 w-3.5" />
        </button>
        <span className="hidden rounded-full border border-[#263128] px-2 py-0.5 text-[10px] text-[#6f7d6c] lg:inline">
          단계 미설정
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled
            title="커맨드 팔레트는 아직 구현되지 않았습니다"
            className="hidden cursor-not-allowed items-center gap-1.5 rounded-md border border-[#263128] px-2 py-1.5 text-[11px] text-[#4f5c4d] sm:flex"
          >
            <Icon name="command" className="h-3.5 w-3.5" />
            <span>⌘K</span>
          </button>
          <button
            type="button"
            disabled
            title="새 작업은 아직 구현되지 않았습니다"
            className="cursor-not-allowed rounded-md border border-[#263128] px-2.5 py-1.5 text-[11px] text-[#4f5c4d]"
          >
            + 새 작업
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={[
            "hidden shrink-0 flex-col border-r border-[#263128] bg-[#0b0f0c] transition-[width] duration-150 md:flex",
            collapsed ? "w-[64px]" : "w-[220px]",
          ].join(" ")}
        >
          <nav className="flex-1 space-y-0.5 px-2 py-3">
            <NavItem icon="home" label="Home" active collapsed={collapsed} />
            <NavItem icon="layers" label="Outputs" disabled collapsed={collapsed} />
            <NavItem icon="check" label="Tasks" disabled collapsed={collapsed} />
            <NavItem icon="calendar" label="Calendar" disabled collapsed={collapsed} />
            <div className="my-2 border-t border-[#263128]" />
            <NavItem icon="message" label="Sessions" collapsed={collapsed} onClick={onOpenChat} />
            <NavItem icon="settings" label="Settings" collapsed={collapsed} onClick={onOpenAdmin} />
          </nav>

          <div className="space-y-2 border-t border-[#263128] p-2">
            {!collapsed ? (
              <div className="rounded-lg border border-[#263128] bg-[#0e140f] p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-[#6f7d6c]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#3a4538]" />
                  홈 데이터 미연결
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-[#4f5c4d]">
                  회색 카드는 UI만 있고 데이터 소스가 없는 상태입니다.
                </p>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              className={[
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] text-[#6f7d6c] hover:bg-[#162018] hover:text-[#e7ecdf]",
                collapsed ? "justify-center px-0" : "",
              ].join(" ")}
              title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
            >
              <Icon name={collapsed ? "panel-open" : "panel-close"} />
              {!collapsed ? <span>사이드바 접기</span> : null}
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto pb-20 md:pb-0">
            <div className="mx-auto max-w-[1180px] px-4 py-5 lg:px-8 lg:py-7">
              <div className="mb-7 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6f7d6c]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#9bcf5f]" />
                    Project home
                  </div>
                  <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[#e7ecdf]">프로젝트 홈</h1>
                  <p className="mt-1 max-w-xl text-sm leading-relaxed text-[#8b978a]">
                    산출물과 워크스트림의 현재 상태를 한눈에 봅니다. 데이터가 연결되지 않은 항목은 비어 있습니다.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled
                    title="상황 브리프는 아직 구현되지 않았습니다"
                    className="cursor-not-allowed rounded-md border border-[#263128] px-3 py-1.5 text-xs text-[#4f5c4d]"
                  >
                    상황 브리프
                  </button>
                  <button
                    type="button"
                    disabled
                    title="새 작업은 아직 구현되지 않았습니다"
                    className="cursor-not-allowed rounded-md border border-[#263128] bg-[#162018] px-3 py-1.5 text-xs font-medium text-[#6f7d6c] opacity-60"
                  >
                    새 작업
                  </button>
                </div>
              </div>

              <section className="mb-7">
                <SectionHeader title="Next actions" note="현재 상태 기준" />
                <EmptyState
                  icon="alert"
                  title="아직 표시할 액션이 없습니다."
                  description="git, 빌드, 태스크, 에셋 데이터 소스가 연결되면 블로커와 마감이 여기에 나타납니다."
                />
              </section>

              <section className="mb-7">
                <SectionHeader title="Outputs" note="타입별 현재 산출물" />
                <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
                  {OUTPUTS.map((output) => (
                    <OutputCard key={output.id} label={output.label} hint={output.hint} icon={output.icon} />
                  ))}
                </div>
              </section>

              <section>
                <SectionHeader title="Workstreams" note="병렬 작업 상태" />
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
                  {WORKSTREAMS.map((stream) => (
                    <WorkstreamCard key={stream.id} label={stream.label} hint={stream.hint} />
                  ))}
                </div>
              </section>
            </div>
          </main>

          <aside className="hidden w-[300px] shrink-0 flex-col border-l border-[#263128] bg-[#0b0f0c] xl:flex">
            <div className="space-y-6 p-4">
              <section>
                <SectionHeader title="This week" />
                <div className="grid grid-cols-7 gap-1">
                  {days.map((day, index) => {
                    const isToday = sameDay(day, today);
                    return (
                      <div key={day.toISOString()} className="flex flex-col items-center gap-1">
                        <span className="text-[9px] text-[#5f6b5d]">{DAY_LABELS[index]}</span>
                        <span
                          className={[
                            "flex h-7 w-7 items-center justify-center rounded-full text-[11px]",
                            isToday ? "bg-[#9bcf5f] font-semibold text-[#0b0f0c]" : "text-[#8b978a]",
                          ].join(" ")}
                        >
                          {day.getDate()}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 rounded-lg border border-dashed border-[#2c3a2c] px-3 py-2 text-[11px] text-[#5f6b5d]">
                  일정 없음
                </div>
              </section>

              <section>
                <SectionHeader title="Today" />
                <div className="rounded-lg border border-dashed border-[#2c3a2c] px-3 py-4 text-center text-[11px] text-[#5f6b5d]">
                  오늘 표시할 항목이 없습니다.
                </div>
              </section>

              <section>
                <SectionHeader title="Ask Kiwi" />
                <div className="rounded-xl border border-[#263128] bg-[#111713] p-3">
                  <div className="flex items-center gap-2 text-[11px] text-[#6f7d6c]">
                    <Icon name="sparkles" className="h-3.5 w-3.5 text-[#9bcf5f]" />
                    상황 브리프
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-[#5f6b5d]">
                    데이터 소스가 연결되면 현재 상태를 읽고 이번 주 블로커와 다음 액션을 요약합니다.
                  </p>
                  <div className="mt-3 flex gap-1.5">
                    <input
                      disabled
                      placeholder="데이터 연결 후 사용 가능"
                      className="min-w-0 flex-1 cursor-not-allowed rounded-md border border-[#263128] bg-[#0e140f] px-2 py-1.5 text-[11px] text-[#4f5c4d] placeholder:text-[#3f4a3d]"
                    />
                    <button
                      type="button"
                      disabled
                      className="cursor-not-allowed rounded-md border border-[#263128] px-2 py-1.5 text-[11px] text-[#4f5c4d]"
                    >
                      질문
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid h-16 grid-cols-5 border-t border-[#263128] bg-[#0b0f0c] md:hidden">
        <MobileNav icon="home" label="홈" active />
        <MobileNav icon="layers" label="산출물" disabled />
        <MobileNav icon="check" label="태스크" disabled />
        <MobileNav icon="message" label="세션" onClick={onOpenChat} />
        <MobileNav icon="settings" label="관리" onClick={onOpenAdmin} />
      </nav>
    </div>
  );
}

function MobileNav({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "relative flex flex-col items-center justify-center gap-0.5 text-[10px]",
        disabled ? "cursor-not-allowed text-[#3f4a3d]" : active ? "text-[#9bcf5f]" : "text-[#8b978a]",
      ].join(" ")}
    >
      <Icon name={icon} className="h-4 w-4" />
      <span>{label}</span>
      {active ? <span className="absolute bottom-1 h-0.5 w-4 rounded-full bg-[#9bcf5f]" /> : null}
    </button>
  );
}
