"use client";

import Link from "next/link";
import { cn } from "@schulos/ui/cn";
import { Avatar } from "@schulos/ui/misc";

export type SeatStatus = "present" | "absent" | "late";

export interface SeatPlanProps {
  title: string;
  href: string;
  rows: number;
  cols: number;
  desks: string[];
  seats: { studentId: string; row: number; col: number }[];
  students: { id: string; name: string; initials: string; photo?: string }[];
}

const LABEL: Record<SeatStatus, string> = { present: "anwesend", absent: "fehlt", late: "verspätet" };

/**
 * P5-03: Sitzplan im Klassenbuch-Eintrag – ein Klick auf den Platz schaltet zwischen „anwesend“ und „fehlt“ (verspätet
 * → anwesend). Der Klick setzt die Auswahl in der Anwesenheitsliste darunter (die Liste bleibt die Quelle des Formulars,
 * Verspätungen mit Minuten gibt es nur dort).
 */
export function SeatAttendance({ plan, statuses, onToggle }: { plan: SeatPlanProps; statuses: Record<string, SeatStatus>; onToggle: (studentId: string, next: SeatStatus) => void }) {
  const desks = new Set(plan.desks);
  const at = new Map(plan.seats.map((s) => [`${s.row}:${s.col}`, s.studentId]));
  const byId = new Map(plan.students.map((s) => [s.id, s]));
  const absent = Object.values(statuses).filter((s) => s === "absent").length;
  return (
    <section role="group" aria-label={`Sitzplan ${plan.title}`} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Sitzplan · {plan.title}
          <span className="font-normal text-muted"> · Klick auf den Platz: fehlt / anwesend · {absent} fehlen</span>
        </h2>
        <Link href={plan.href} className="text-sm font-medium text-accent-ink hover:underline">
          Sitzplan bearbeiten
        </Link>
      </div>
      <div className="rounded-lg bg-surface-2 py-0.5 text-center text-xs text-muted" aria-hidden>
        vorn · Tafel
      </div>
      <div className="grid gap-1 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${plan.cols}, minmax(3.75rem, 1fr))` }}>
        {Array.from({ length: plan.rows * plan.cols }, (_, i) => {
          const k = `${Math.floor(i / plan.cols)}:${i % plan.cols}`;
          const sid = at.get(k);
          const s = sid ? byId.get(sid) : undefined;
          const status = s ? statuses[s.id] : undefined;
          if (!desks.has(k)) return <span key={k} aria-hidden />;
          if (!s || !status) return <span key={k} aria-hidden className="min-h-16 rounded-lg border border-dashed border-border" />;
          return (
            <button
              key={k}
              type="button"
              aria-label={`${s.name}: ${LABEL[status]}`}
              aria-pressed={status === "absent"}
              onClick={() => onToggle(s.id, status === "present" ? "absent" : "present")}
              className={cn(
                "flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-center text-[11px] leading-tight",
                status === "present" && "border-border-strong bg-surface",
                status === "absent" && "border-danger bg-danger-soft font-semibold text-danger",
                status === "late" && "border-warn-border bg-warn-soft text-warn",
              )}
            >
              <Avatar label={s.initials} src={s.photo} className="size-7 text-[11px]" tone="soft" />
              <span className="line-clamp-2">{s.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
