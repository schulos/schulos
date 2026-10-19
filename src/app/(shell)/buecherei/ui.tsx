import Link from "next/link";
import type { PermissionSet } from "@/core/permissions";
import { canDesk } from "@/modules/buecherei/loans";
import { canStock } from "@/modules/buecherei/service";

const SECTIONS = [
  { key: "theke", href: "/buecherei/theke", label: "Theke", allowed: canDesk },
  { key: "bestand", href: "/buecherei/bestand", label: "Bestand", allowed: canStock },
  { key: "ausweise", href: "/buecherei/ausweise", label: "Ausweise", allowed: canDesk },
] as const;

export type BuechereiSection = (typeof SECTIONS)[number]["key"];

/** Bereiche der Bücherei nach Recht (Theke und Ausweise: `desk`, Bestand: `stock`). */
export function BuechereiNav({ current, perms }: { current: BuechereiSection; perms: PermissionSet }) {
  const visible = SECTIONS.filter((s) => s.allowed(perms));
  if (visible.length < 2) return null;
  return (
    <nav aria-label="Bücherei" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-xl border border-border bg-surface p-1">
        {visible.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              aria-current={s.key === current ? "page" : undefined}
              className={
                s.key === current
                  ? "flex h-9 items-center rounded-lg bg-accent-soft px-3 text-sm font-semibold whitespace-nowrap text-accent-ink"
                  : "flex h-9 items-center rounded-lg px-3 text-sm whitespace-nowrap text-muted transition hover:text-ink"
              }
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
