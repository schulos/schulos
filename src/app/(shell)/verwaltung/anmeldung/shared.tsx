import Link from "next/link";
import { asc, desc } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { TZ } from "@/core/time";
import { VERFAHREN_STATUS_LABELS, type VerfahrenStatus } from "@/modules/anmeldung/labels";
import { listGradeLevels } from "@/modules/verwaltung/stammdaten";
import { Badge } from "@schulos/ui/badge";

export const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
export const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
export const timeFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: TZ });

const TONE: Record<VerfahrenStatus, "neutral" | "success" | "warn" | "soft"> = { entwurf: "neutral", offen: "success", geschlossen: "warn", abgeschlossen: "soft" };

export function VerfahrenBadge({ status }: { status: VerfahrenStatus }) {
  return <Badge tone={TONE[status]}>{VERFAHREN_STATUS_LABELS[status]}</Badge>;
}

export async function formOptions(db: Db) {
  const [years, grades] = await Promise.all([
    db.select({ id: schoolYears.id, name: schoolYears.name }).from(schoolYears).orderBy(desc(schoolYears.startsOn), asc(schoolYears.id)),
    listGradeLevels(db),
  ]);
  return { years, grades: grades.map((g) => ({ level: g.level, name: g.name })) };
}

/** Unternavigation eines Verfahrens. */
export function VerfahrenNav({ id, current }: { id: string; current: "uebersicht" | "antraege" | "entscheidung" | "export" | "termine" | "vorschau" }) {
  const items = [
    { key: "uebersicht", href: `/verwaltung/anmeldung/${id}`, label: "Übersicht" },
    { key: "antraege", href: `/verwaltung/anmeldung/${id}/antraege`, label: "Anträge" },
    { key: "entscheidung", href: `/verwaltung/anmeldung/${id}/entscheidung`, label: "Entscheidung" },
    { key: "export", href: `/verwaltung/anmeldung/${id}/export`, label: "Export" },
    { key: "termine", href: `/verwaltung/anmeldung/${id}/termine`, label: "Gesprächstermine" },
    { key: "vorschau", href: `/verwaltung/anmeldung/${id}/vorschau`, label: "Vorschau für Eltern" },
  ] as const;
  return (
    <nav aria-label="Verfahren" className="flex flex-wrap gap-2 text-sm">
      <Link href="/verwaltung/anmeldung" className="rounded-lg px-3 py-1.5 text-muted hover:bg-surface-2">
        ← Alle Verfahren
      </Link>
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.key === current ? "page" : undefined}
          className={i.key === current ? "rounded-lg bg-accent-soft px-3 py-1.5 font-medium text-accent-ink" : "rounded-lg px-3 py-1.5 hover:bg-surface-2"}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
