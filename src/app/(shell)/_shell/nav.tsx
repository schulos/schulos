"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavEntry, NavGroup } from "@/core/modules/registry";
import { cn } from "@schulos/ui/cn";
import { ModuleIcon } from "@schulos/ui/icons";
import { useLive } from "./live";

/** Aktiv, wenn der Pfad passt und kein spezifischerer Eintrag (z. B. /stundenplan/raeume statt /stundenplan) ebenfalls passt. */
function isActive(pathname: string, href: string, all: string[] = []) {
  const matches = (h: string) => (h === "/" ? pathname === "/" : pathname === h || pathname.startsWith(`${h}/`));
  return matches(href) && !all.some((h) => h.length > href.length && h.startsWith(`${href}/`) && matches(h));
}

/** Zähler je Modul: Startwert vom Server, danach live (Chat). */
function useBadges(initial: Record<string, number>) {
  const [badges, setBadges] = useState(initial);
  useLive((m) => {
    if (m.type === "chat") setBadges((b) => ({ ...b, messenger: (b.messenger ?? 0) + 1 }));
    // unreadTotal kommt nur im eigenen chat-read-Ereignis mit – korrigiert den Zähler (auch für eigene Nachrichten)
    if (m.type === "chat-read" && m.unreadTotal !== undefined) setBadges((b) => ({ ...b, messenger: m.unreadTotal! }));
  });
  return badges;
}

function Count({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return (
    <span data-testid={`badge-${label}`} className="grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1.5 text-xs font-semibold text-surface">
      {n > 99 ? "99+" : n}
      <span className="sr-only"> ungelesen</span>
    </span>
  );
}

function SidebarLink({ item, badge = 0, all }: { item: NavEntry; badge?: number; all?: string[] }) {
  const active = isActive(usePathname(), item.href, all);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] text-ink transition hover:bg-surface-2",
        active && "bg-accent-soft font-semibold text-accent-ink hover:bg-accent-soft",
      )}
    >
      <ModuleIcon name={item.icon} className="size-5" />
      <span className="flex-1 truncate">{item.label}</span>
      <Count n={badge} label={item.moduleId} />
    </Link>
  );
}

export function SidebarNav({ groups, badges: initial = {} }: { groups: NavGroup[]; badges?: Record<string, number> }) {
  const badges = useBadges(initial);
  const main = groups.filter((g) => g.section !== "verwaltung");
  const admin = groups.find((g) => g.section === "verwaltung");
  const all = groups.flatMap((g) => g.items.map((i) => i.href));
  return (
    <nav aria-label="Hauptnavigation" className="flex flex-1 flex-col gap-6">
      {main.map((g) => (
        <div key={g.section} className="flex flex-col gap-0.5">
          {g.label && (
            <span className="px-3 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{g.label}</span>
          )}
          {g.items.map((item) => (
            <SidebarLink key={item.href} item={item} badge={badges[item.moduleId]} all={all} />
          ))}
        </div>
      ))}
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-4">
        <SidebarLink item={{ moduleId: "apps", href: "/apps", label: "Alle Apps", icon: "LayoutGrid" }} />
        {admin?.items.map((item) => <SidebarLink key={item.href} item={item} />)}
      </div>
    </nav>
  );
}

/** Mobile Bottom-Bar: die ersten vier Einträge + „Mehr". */
export function MobileTabBar({ groups, badges: initial = {} }: { groups: NavGroup[]; badges?: Record<string, number> }) {
  const pathname = usePathname();
  const badges = useBadges(initial);
  // Module mit mobile-Priorität, sonst nach Reihenfolge – höchstens vier, Rest unter „Mehr“
  const items = groups
    .filter((g) => g.section !== "verwaltung")
    .flatMap((g) => g.items)
    .filter((i) => i.mobile !== undefined)
    .sort((a, b) => a.mobile! - b.mobile!)
    .slice(0, 4);
  const tabs = [...items, { moduleId: "apps", href: "/apps", label: "Mehr", icon: "LayoutGrid" }];
  return (
    <nav
      aria-label="Navigation"
      className="fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-surface/95 px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur lg:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => {
        const active = isActive(pathname, t.href, groups.flatMap((g) => g.items.map((i) => i.href)));
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 text-xs text-muted",
              active && "font-semibold text-accent-ink",
            )}
          >
            <span className="relative">
              <ModuleIcon name={t.icon} className="size-[22px]" />
              {(badges[t.moduleId] ?? 0) > 0 && <span aria-hidden className="absolute -top-1 -right-1.5 size-2.5 rounded-full bg-accent ring-2 ring-surface" />}
            </span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
