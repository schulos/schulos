// Q5-13: Fehlzeiten einer Schülerin/eines Schülers (eigene Sicht bzw. Eltern minderjähriger Kinder).
import { TZ, fromBerlinLocal } from "@/core/time";
import { DAY_STATUS_LABEL, type AbsenceDay, type AbsenceTotals, type DayStatus } from "@/modules/abwesenheiten/fehlzeiten";
import { Badge } from "@schulos/ui/badge";

const dayLabel = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const TONE: Record<DayStatus, "warn" | "success" | "danger" | "neutral"> = {
  ohne_meldung: "neutral",
  gemeldet: "warn",
  entschuldigt: "success",
  nicht_entschuldigt: "danger",
};

export function Fehlzeiten({ id, title, days, totals, from }: { id: string; title: string; days: AbsenceDay[]; totals: AbsenceTotals; from: string }) {
  const since = dayLabel.format(fromBerlinLocal(from));
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-display text-xl font-bold">
        {title}
      </h2>
      <p className="text-sm text-muted">
        Seit {since}: {totals.absent} {totals.absent === 1 ? "Fehlstunde" : "Fehlstunden"} ({totals.excused} entschuldigt, {totals.unexcused} nicht entschuldigt, {totals.open} offen) ·{" "}
        {totals.lateCount} {totals.lateCount === 1 ? "Verspätung" : "Verspätungen"}
        {totals.lateMinutes > 0 && ` (${totals.lateMinutes} Min.)`}
      </p>
      {days.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-muted">Keine Fehlzeiten eingetragen.</p>
      ) : (
        <ul className="rounded-card border border-border bg-surface px-4">
          {days.map((d) => (
            <li key={d.date} className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex flex-col leading-tight">
                <span className="font-medium">{dayLabel.format(fromBerlinLocal(d.date))}</span>
                <span className="text-sm text-muted">
                  {d.lessons
                    .map((l) => (l.kind === "late" ? `${l.periodNr}. Std ${l.subjectName}: ${l.minutesLate} Min. verspätet` : `${l.periodNr}. Std ${l.subjectName}`))
                    .join(" · ")}
                </span>
              </span>
              {d.status ? <Badge tone={TONE[d.status]}>{DAY_STATUS_LABEL[d.status]}</Badge> : <Badge tone="neutral">verspätet</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
