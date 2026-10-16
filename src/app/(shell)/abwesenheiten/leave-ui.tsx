// Q5-16: Bausteine für Beurlaubungen (Liste, Entscheiden, Hinweis im Antragsformular).
import { decideLeaveAction } from "@/modules/abwesenheiten/actions";
import { LEAVE_DECIDER_LABEL, LEAVE_REASON_LABEL, LEAVE_STATUS_LABEL, type LeaveRow } from "@/modules/abwesenheiten/beurlaubung";
import { rangeLabel } from "@/modules/abwesenheiten/labels";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";

const LEAVE_TONE = { beantragt: "warn", genehmigt: "success", abgelehnt: "danger" } as const;
export const LEAVE_REASONS = Object.entries(LEAVE_REASON_LABEL).map(([value, label]) => ({ value, label }));

/** Hinweis im Antragsformular (Q5-16): Grenze aus der Moduleinstellung, keine Einzelheiten */
export function leaveHint(limit: number): string {
  const who = limit === 0 ? "Über Beurlaubungen entscheidet die Schulleitung." : `Bis ${limit === 1 ? "1 Schultag" : `${limit} Schultage`} entscheidet die Klassenleitung, darüber die Schulleitung.`;
  return `${who} Bitte nur den Grund auswählen, keine Einzelheiten.`;
}

/** Beurlaubungen als Liste; `actions` je Antrag (Entscheiden, Zurückziehen) */
export function LeaveList({ rows, showClass, actions, empty }: { rows: LeaveRow[]; showClass: boolean; actions?: (r: LeaveRow) => React.ReactNode; empty: string }) {
  if (rows.length === 0) return <p className="rounded-card border border-border bg-surface p-4 text-muted">{empty}</p>;
  return (
    <ul className="rounded-card border border-border bg-surface px-4">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex flex-col leading-tight">
            <span className="font-medium">
              {r.studentName}
              {showClass && r.groupName && <span className="font-normal text-muted"> · {r.groupName}</span>}
            </span>
            <span className="text-sm text-muted">
              {rangeLabel(r.fromDate, r.toDate)} · {r.schoolDays} {r.schoolDays === 1 ? "Schultag" : "Schultage"} · {LEAVE_REASON_LABEL[r.reason]} · entscheidet: {LEAVE_DECIDER_LABEL[r.decider]}
              {r.requestedByName && ` · beantragt von ${r.requestedByName}`}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {actions?.(r) ?? <Badge tone={LEAVE_TONE[r.status]}>{LEAVE_STATUS_LABEL[r.status]}</Badge>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DecideButtons({ r }: { r: LeaveRow }) {
  return (
    <>
      <form action={decideLeaveAction.bind(null, r.id, true)}>
        <Button type="submit" size="sm" variant="primary" aria-label={`Beurlaubung genehmigen: ${r.studentName}`}>
          Genehmigen
        </Button>
      </form>
      <form action={decideLeaveAction.bind(null, r.id, false)}>
        <Button type="submit" size="sm" aria-label={`Beurlaubung ablehnen: ${r.studentName}`}>
          Ablehnen
        </Button>
      </form>
    </>
  );
}
