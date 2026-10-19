"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./cn";

export interface SubNavTab {
  href: string;
  label: string;
}

/**
 * Reiter-Leiste eines Bereichs (Verwaltung, Stundenplanung). `root` ist die Übersicht des Bereichs und nur bei genau
 * diesem Pfad aktiv; alle anderen Reiter sind auch auf ihren Unterseiten aktiv.
 */
export function SubNav({ tabs, label, root }: { tabs: SubNavTab[]; label: string; root: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-xl border border-border bg-surface p-1">
        {tabs.map((t) => {
          const active = t.href === root ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center rounded-lg px-3 text-sm whitespace-nowrap text-muted transition hover:text-ink",
                  active && "bg-accent-soft font-semibold text-accent-ink",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
