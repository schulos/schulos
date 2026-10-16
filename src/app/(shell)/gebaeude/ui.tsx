import Link from "next/link";
import { CATEGORY_LABELS, STATUS_LABELS, placeLabel, type TicketPriority, type TicketStatus } from "@/modules/gebaeude/labels";
import type { TicketRow } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";

const STATUS_TONE: Record<TicketStatus, "neutral" | "soft" | "warn" | "success" | "danger"> = {
  neu: "warn",
  angenommen: "soft",
  in_arbeit: "soft",
  wartet_extern: "neutral",
  erledigt: "success",
  abgelehnt: "neutral",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

/** Prioritätsmarker: nur „hoch“ und „Gefahr“ fallen auf. */
export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  if (priority === "gefahr") return <Badge tone="danger">⚠ Gefahr</Badge>;
  if (priority === "hoch") return <Badge tone="warn">hoch</Badge>;
  return null;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });

/** Eine Meldung als Zeile bzw. Karte (Board und Listen). */
export function TicketItem({ t, showStatus = true, showReporter = false }: { t: TicketRow; showStatus?: boolean; showReporter?: boolean }) {
  return (
    <Link
      href={`/gebaeude/${t.id}`}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 hover:ring-1 hover:ring-border-strong"
      aria-label={`${t.number}: ${t.title}`}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted tabular-nums">{t.number}</span>
        <PriorityBadge priority={t.priority} />
        {showStatus && <StatusBadge status={t.status} />}
      </span>
      <span className="font-medium leading-snug">{t.title}</span>
      <span className="text-xs text-muted">
        {placeLabel(t)} · {CATEGORY_LABELS[t.category]} · {dayFmt.format(t.createdAt)}
        {showReporter && t.reporterName && ` · ${t.reporterName}`}
        {t.assigneeName && ` · bei ${t.assigneeName}`}
      </span>
    </Link>
  );
}

const SECTIONS = [
  { key: "meldungen", href: "/gebaeude", label: "Meldungen" },
  { key: "pruefungen", href: "/gebaeude/pruefungen", label: "Prüfungen" },
  { key: "anlagen", href: "/gebaeude/anlagen", label: "Anlagen" },
  { key: "wartung", href: "/gebaeude/wartung", label: "Wartung" },
  { key: "statistik", href: "/gebaeude/statistik", label: "Statistik" },
  { key: "pruefarten", href: "/gebaeude/pruefarten", label: "Prüfarten" },
] as const;

/** Bereiche des Moduls für Bearbeitung und Leitung (`manage`/`view_all`); „Prüfarten“ nur mit `configure`. */
export function GebaeudeNav({ current, configure = false }: { current: (typeof SECTIONS)[number]["key"]; configure?: boolean }) {
  return (
    <nav aria-label="Gebäude & Technik" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-xl border border-border bg-surface p-1">
        {SECTIONS.filter((s) => s.key !== "pruefarten" || configure).map((s) => (
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
