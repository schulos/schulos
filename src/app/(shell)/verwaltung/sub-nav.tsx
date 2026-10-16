"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@schulos/ui/cn";

export function SubNav({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Verwaltung" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-xl border border-border bg-surface p-1">
        {tabs.map((t) => {
          const active = t.href === "/verwaltung" ? pathname === t.href : pathname.startsWith(t.href);
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
