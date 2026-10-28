"use client";

import { useState, useTransition } from "react";
import { setAllPresentAction, setMarkAction } from "@/modules/ganztag/actions";
import type { ListRow } from "@/modules/ganztag/service";
import { cn } from "@schulos/ui/cn";
import { Select } from "@schulos/ui/field";

type Status = NonNullable<ListRow["status"]>;

const BUTTONS: { value: Status; label: string; on: string }[] = [
  { value: "anwesend", label: "anwesend", on: "border-success bg-success-soft text-success" },
  { value: "fehlt", label: "fehlt", on: "border-danger bg-danger-soft text-danger" },
  { value: "verspaetet", label: "verspätet", on: "border-warn-border bg-warn-soft text-warn" },
];

const MINUTES = [5, 10, 15, 20, 30, 45, 60];

/**
 * Anwesenheitsliste (GT-03): je Zeile ein Klick auf anwesend / fehlt / verspätet, erneuter Klick leert die Zeile. Die Liste startet
 * leer; „alle anwesend“ ist ein Schalter für alle Zeilen ohne eigene Markierung.
 */
export function AttendanceList({ sessionId, rows, allPresent, editable }: { sessionId: string; rows: ListRow[]; allPresent: boolean; editable: boolean }) {
  const fromRows = (list: ListRow[]) => new Map(list.map((r) => [r.studentId, { status: r.status, minutes: r.minutesLate }]));
  const [marks, setMarks] = useState(() => fromRows(rows));
  const [all, setAll] = useState(allPresent);
  // neuer Stand vom Server (nach dem Speichern): übernehmen, ohne die Liste neu aufzubauen (Fokus bleibt)
  const [shown, setShown] = useState({ rows, allPresent });
  if (shown.rows !== rows || shown.allPresent !== allPresent) {
    setShown({ rows, allPresent });
    setMarks(fromRows(rows));
    setAll(allPresent);
  }
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(studentId: string, status: Status | null, minutes: number | null) {
    const before = marks.get(studentId);
    setMarks(new Map(marks).set(studentId, { status, minutes }));
    start(async () => {
      const r = await setMarkAction(sessionId, studentId, status, minutes);
      if (r.error) {
        setError(r.error);
        setMarks((m) => new Map(m).set(studentId, before ?? { status: null, minutes: null }));
      } else setError(null);
    });
  }

  function toggleAll() {
    const next = !all;
    setAll(next);
    start(async () => {
      const r = await setAllPresentAction(sessionId, next);
      if (r.error) {
        setError(r.error);
        setAll(!next);
      } else setError(null);
    });
  }

  return (
    <section aria-label="Anwesenheitsliste" className="flex flex-col gap-3">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 self-start rounded-xl border border-border bg-surface px-3">
        <input type="checkbox" role="switch" className="size-4 accent-[var(--accent)]" checked={all} disabled={!editable || pending} onChange={toggleAll} />
        <span className="font-medium">Alle anwesend</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const m = marks.get(r.studentId) ?? { status: null, minutes: null };
          return (
            <li key={r.studentId} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-muted">
                  {r.className ?? "ohne Klasse"}
                  {r.former && " · nicht mehr in der Gruppe"}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span role="group" aria-label={r.name} className="flex flex-wrap gap-1.5">
                  {BUTTONS.map((b) => {
                    const on = m.status === b.value;
                    return (
                      <button
                        key={b.value}
                        type="button"
                        aria-pressed={on}
                        disabled={!editable}
                        onClick={() => save(r.studentId, on ? null : b.value, b.value === "verspaetet" && !on ? m.minutes : null)}
                        className={cn(
                          "inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-3 text-sm font-medium transition disabled:opacity-50",
                          on ? b.on : "text-ink hover:bg-surface-2",
                        )}
                      >
                        {b.label}
                      </button>
                    );
                  })}
                </span>
                {m.status === "verspaetet" && (
                  <Select
                    aria-label={`Minuten verspätet: ${r.name}`}
                    className="w-auto"
                    value={m.minutes ?? ""}
                    disabled={!editable}
                    onChange={(e) => save(r.studentId, "verspaetet", e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Minuten?</option>
                    {MINUTES.map((n) => (
                      <option key={n} value={n}>
                        {n} min
                      </option>
                    ))}
                  </Select>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
