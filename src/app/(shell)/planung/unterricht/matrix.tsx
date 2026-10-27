"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { rankTeachers, subjectFilterOn, subjectFit, type PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import {
  cellKey,
  cellValue,
  liveBalance,
  liveRest,
  resolveTeacher,
  sameValue,
  teacherText,
  type BalanceAccount,
  type CellValue,
  type Matrix,
  type MatrixCell,
  type MatrixEdit,
  type Suggestion,
} from "@/modules/stundenplan/matrix-rechnung";
import type { MatrixSaveResult } from "@/modules/stundenplan/matrix";

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

interface Draft {
  text: string;
  hours: string;
  /** „Trotzdem zuweisen“ angekreuzt */
  offOk: boolean;
  /** Herkunft eines Übernahme-Vorschlags */
  suggested?: string;
}

type SaveAction = (edits: MatrixEdit[], refYmd: string, source: string) => Promise<{ results: MatrixSaveResult[]; error?: string }>;

const draftOf = (cell: MatrixCell, byId: Map<string, PickTeacher>): Draft => {
  const v = cellValue(cell);
  return { text: teacherText(v.teacherId ? byId.get(v.teacherId) : null), hours: v.hours ? String(v.hours) : "", offOk: false };
};

/**
 * SP3-LA: Matrix Klasse × Fach. Zelle = Lehrkraft (Typeahead: vorgeschlagen nur aktive Lehrkräfte mit dem Lehrfach, sortiert nach
 * Restdeputat; „alle anzeigen“ mit Warnhinweis, fachfremd nur mit „Trotzdem zuweisen“) und Wochenstunden; leer = Stundentafel-Soll als
 * Platzhalter. Enter speichert die Zelle, Esc setzt sie zurück; „Änderungen speichern“ speichert alle. Seitenleiste: Deputatsbilanz der
 * betroffenen Lehrkräfte live (Soll am Stichtag − Lehraufträge inkl. ungespeicherter Änderungen).
 */
export function MatrixEditor({
  matrix,
  accounts,
  teachers,
  refYmd,
  suggestions,
  source,
  editHref,
  save,
}: {
  matrix: Matrix;
  accounts: BalanceAccount[];
  teachers: PickTeacher[];
  refYmd: string;
  suggestions: Suggestion[];
  source: "matrix" | "vorjahr" | "halbjahr";
  /** Link ins Formular je Lehrauftrag (Band, Teamteaching) */
  editHref: Record<string, string>;
  save: SaveAction;
}) {
  const router = useRouter();
  const byId = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);
  const active = useMemo(() => teachers.filter((t) => !t.inactive), [teachers]);
  const filterOn = subjectFilterOn(teachers);
  const cells = useMemo(() => {
    const m = new Map<string, MatrixCell>();
    for (const r of matrix.rows) for (const c of r.cells) m.set(cellKey(c.groupId, c.subjectId), c);
    return m;
  }, [matrix]);
  const subjectName = useMemo(() => new Map(matrix.columns.map((c) => [c.subjectId, c.name])), [matrix]);
  const groupName = useMemo(() => new Map(matrix.rows.map((r) => [r.groupId, r.name])), [matrix]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const out: Record<string, Draft> = {};
    for (const s of suggestions) {
      const t = s.teacherId ? byId.get(s.teacherId) : null;
      out[cellKey(s.groupId, s.subjectId)] = { text: teacherText(t), hours: String(s.hours), offOk: false, suggested: s.from };
    }
    return out;
  });
  const [errors, setErrors] = useState<Record<string, MatrixSaveResult>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [pending, startTransition] = useTransition();

  const draft = (key: string): Draft => drafts[key] ?? draftOf(cells.get(key)!, byId);

  /** Wert nach der Eingabe; `error` = Lehrkraft nicht auflösbar bzw. Stunden ungültig */
  const evaluate = (key: string) => {
    const cell = cells.get(key)!;
    const d = draft(key);
    const before = cellValue(cell);
    const found = resolveTeacher(d.text, teachers);
    const hoursText = d.hours.trim();
    const hours = hoursText === "" ? (found?.teacher ? (cell.soll ?? 0) : 0) : Number(hoursText);
    let error: string | null = null;
    if (!found) error = `„${d.text.trim()}“ ist keine Lehrkraft`;
    else if (found.teacher?.inactive && found.teacher.id !== before.teacherId) error = `${teacherText(found.teacher)} ist nicht mehr aktiv`;
    else if (!Number.isInteger(hours) || hours < 0 || hours > 12) error = "0 bis 12 Stunden";
    const after: CellValue = { teacherId: found?.teacher?.id ?? null, hours: Number.isInteger(hours) ? hours : before.hours };
    const fit = found?.teacher && filterOn ? subjectFit(found.teacher.subjectIds, cell.subjectId) : "fits";
    return { cell, d, before, after, error, off: fit === "off", unmaintained: fit === "unmaintained", dirty: !!drafts[key] && (!!error || !sameValue(before, after)) };
  };

  const keys = Object.keys(drafts).filter((k) => cells.get(k)?.editable);
  const evaluated = keys.map((k) => ({ key: k, ...evaluate(k) })).filter((e) => e.dirty);
  const valid = evaluated.filter((e) => !e.error);
  const changes = valid.map((e) => ({ before: e.before, after: e.after }));
  const balance = liveBalance(accounts, changes);
  const rest = liveRest(accounts, changes);

  const setDraft = (key: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draftOf(cells.get(key)!, byId)), ...patch } }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  const reset = (list: string[]) => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const k of list) delete next[k];
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      for (const k of list) delete next[k];
      return next;
    });
  };

  const submit = (list: typeof evaluated) => {
    const ok = list.filter((e) => !e.error);
    if (!ok.length) return;
    const edits: MatrixEdit[] = ok.map((e) => ({
      groupId: e.cell.groupId,
      subjectId: e.cell.subjectId,
      assignmentId: e.cell.assignments[0]?.id ?? null,
      teacherId: e.after.teacherId,
      hours: e.after.hours,
      offSubjectOk: e.d.offOk ? e.after.teacherId : null,
    }));
    startTransition(async () => {
      const res = await save(edits, refYmd, source);
      if (res.error) {
        setMessage(res.error);
        return;
      }
      const failed = res.results.filter((r) => !r.ok);
      const saved = res.results.filter((r) => r.ok).map((r) => r.key);
      setErrors((prev) => {
        const next = { ...prev };
        for (const r of failed) next[r.key] = r;
        return next;
      });
      reset(saved);
      setMessage(
        failed.length
          ? `${saved.length} gespeichert, ${failed.length} nicht – Hinweise in den markierten Zellen.`
          : `${saved.length} ${saved.length === 1 ? "Änderung" : "Änderungen"} gespeichert.`,
      );
      router.refresh();
    });
  };

  const label = (key: string) => {
    const c = cells.get(key)!;
    return `${groupName.get(c.groupId)}, ${subjectName.get(c.subjectId)}`;
  };

  /** Vorschlagsliste je Fach: aktive Lehrkräfte mit dem Lehrfach (Restdeputat live), mit „alle anzeigen“ auch die übrigen */
  const listId = (subjectId: string) => `matrix-lk-${subjectId}`;
  const datalists = matrix.columns.map((col) => {
    const ranked = rankTeachers(
      active.map((t) => ({ ...t, rest: rest.get(t.id) ?? t.rest })),
      col.subjectId,
    );
    const shown = showAll ? [...ranked.matching, ...ranked.unmaintained, ...ranked.others] : ranked.matching;
    return (
      <datalist key={col.subjectId} id={listId(col.subjectId)}>
        {shown.map((t) => {
          const fit = filterOn ? subjectFit(t.subjectIds, col.subjectId) : "fits";
          const r = t.rest === null ? "" : t.rest >= 0 ? ` · Rest ${num.format(t.rest)}` : ` · ${num.format(-t.rest)} über Soll`;
          return <option key={t.id} value={teacherText(t)} label={`${t.name}${r}${fit === "off" ? " · fachfremd" : fit === "unmaintained" ? " · Lehrfächer fehlen" : ""}`} />;
        })}
      </datalist>
    );
  });

  const rowSum = (row: Matrix["rows"][number]) =>
    row.cells.reduce((s, c) => {
      if (!c.editable) return s + c.assignments.reduce((x, a) => x + a.hours, 0);
      const e = evaluate(cellKey(c.groupId, c.subjectId));
      return s + (e.error ? e.before.hours : e.after.hours);
    }, 0);

  const suggestedOpen = evaluated.filter((e) => e.d.suggested).length;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="primary" disabled={pending || valid.length === 0} onClick={() => submit(evaluated)}>
            {pending ? "Speichern …" : `Änderungen speichern (${valid.length})`}
          </Button>
          <Button type="button" variant="ghost" disabled={pending || keys.length === 0} onClick={() => reset(keys)}>
            Änderungen verwerfen
          </Button>
          {filterOn && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              alle Lehrkräfte vorschlagen (auch fachfremd)
            </label>
          )}
        </div>
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {message ??
            (evaluated.length
              ? `${evaluated.length} ungespeicherte ${evaluated.length === 1 ? "Änderung" : "Änderungen"}${suggestedOpen ? `, davon ${suggestedOpen} Vorschläge` : ""}.`
              : "Keine ungespeicherten Änderungen.")}
        </p>
        {datalists}
        <Table scrollLabel="Matrix Klasse × Fach (Tabelle)">
          <caption className="sr-only">Lehraufträge je Klasse und Fach</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-surface">
                Klasse
              </th>
              {matrix.columns.map((col) => (
                <th key={col.subjectId} scope="col">
                  <span className="flex items-center gap-1.5 normal-case">
                    <SubjectBar color={col.color} className="h-4 w-1 shrink-0" />
                    {col.name}
                  </span>
                </th>
              ))}
              <th scope="col" className="text-right">
                Summe
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const sum = rowSum(row);
              return (
                <tr key={row.groupId}>
                  <th scope="row" className="sticky left-0 z-10 bg-surface text-left font-semibold whitespace-nowrap normal-case! text-sm! tracking-normal! text-ink!">
                    {row.name}
                  </th>
                  {row.cells.map((c) => {
                    const key = cellKey(c.groupId, c.subjectId);
                    if (!c.editable)
                      return (
                        <td key={key} className="align-top">
                          <div className="flex min-w-28 flex-col gap-1 text-sm">
                            {c.soll !== null && <span className="text-xs text-muted">Soll {num.format(c.soll)}</span>}
                            {c.assignments.map((a) => (
                              <Link key={a.id} href={editHref[a.id] ?? "#"} className="hover:underline">
                                {a.teacherCodes.join(" + ") || "offen"} · {a.hours}
                                {a.bandId ? " · Band" : ""}
                              </Link>
                            ))}
                            <span className="text-xs text-muted">im Formular bearbeiten</span>
                          </div>
                        </td>
                      );
                    const e = evaluate(key);
                    const err = errors[key];
                    const shownHours = e.error ? e.before.hours : e.after.hours;
                    const gap = c.soll === null ? null : c.soll - shownHours;
                    const noteId = `${key}-hinweis`;
                    return (
                      <td key={key} className={`align-top ${e.dirty ? "bg-accent-soft" : ""}`}>
                        <div className="flex min-w-28 flex-col gap-1">
                          <span className="text-xs text-muted">
                            {c.soll === null ? "nicht in der Stundentafel" : `Soll ${num.format(c.soll)}`}
                            {gap !== null && gap !== 0 && shownHours > 0 && <span className="text-warn">{gap > 0 ? ` · ${num.format(gap)} offen` : ` · ${num.format(-gap)} zu viel`}</span>}
                          </span>
                          <div className="flex gap-1">
                            <Input
                              aria-label={`Lehrkraft ${label(key)}`}
                              aria-describedby={noteId}
                              aria-invalid={e.error || err ? true : undefined}
                              list={listId(c.subjectId)}
                              autoComplete="off"
                              spellCheck={false}
                              value={e.d.text}
                              placeholder="offen"
                              className="h-9 w-20 px-2 text-sm"
                              onChange={(ev) => setDraft(key, { text: ev.target.value, offOk: false })}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") {
                                  ev.preventDefault();
                                  if (e.dirty && !e.error) submit([{ key, ...e }]);
                                } else if (ev.key === "Escape") reset([key]);
                              }}
                            />
                            <Input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={12}
                              aria-label={`Wochenstunden ${label(key)}`}
                              aria-describedby={noteId}
                              value={e.d.hours}
                              placeholder={c.soll === null ? "0" : String(c.soll)}
                              className="h-9 w-14 px-2 text-sm"
                              onChange={(ev) => setDraft(key, { hours: ev.target.value })}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") {
                                  ev.preventDefault();
                                  if (e.dirty && !e.error) submit([{ key, ...e }]);
                                } else if (ev.key === "Escape") reset([key]);
                              }}
                            />
                          </div>
                          <span id={noteId} className="flex flex-col gap-0.5 text-xs">
                            {e.d.suggested && e.dirty && <span className="text-accent-ink">Vorschlag ({e.d.suggested})</span>}
                            {e.error && <span className="text-danger">{e.error}</span>}
                            {!e.error && e.dirty && e.after.hours === 0 && e.before.hours > 0 && <span className="text-warn">wird gelöscht</span>}
                            {err?.error && <span className="text-danger">{err.error}</span>}
                            {!e.error && e.unmaintained && e.dirty && <span className="text-muted">Lehrfächer fehlen</span>}
                          </span>
                          {!e.error && e.off && e.dirty && (
                            <label className="flex items-center gap-1.5 text-xs font-medium text-warn">
                              <input
                                type="checkbox"
                                checked={e.d.offOk}
                                onChange={(ev) => setDraft(key, { offOk: ev.target.checked })}
                                className="size-4 accent-[var(--accent)]"
                                aria-label={`Trotzdem zuweisen: ${e.d.text.trim()} unterrichtet ${subjectName.get(c.subjectId)} laut Stammdaten nicht (${groupName.get(c.groupId)})`}
                              />
                              fachfremd – trotzdem
                            </label>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="text-right align-top">
                    {row.curriculum === null ? (
                      <span className="tabular-nums">{num.format(sum)}</span>
                    ) : (
                      <Badge tone={sum === row.curriculum ? "success" : sum < row.curriculum ? "warn" : "danger"}>
                        {num.format(sum)} / {num.format(row.curriculum)}
                        <span className="sr-only">
                          {" "}
                          – {sum === row.curriculum ? "entspricht der Stundentafel" : sum < row.curriculum ? `${num.format(row.curriculum - sum)} unter der Stundentafel` : `${num.format(sum - row.curriculum)} über der Stundentafel`}
                        </span>
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <p className="text-sm text-muted">
          Lehrkraft per Kürzel eingeben (Vorschläge: Lehrkräfte mit dem Lehrfach, nach Restdeputat). Leere Stunden = Stundentafel-Soll, 0 Stunden löschen den
          Lehrauftrag. Enter speichert die Zelle, Esc setzt sie zurück. Bänder und Teamteaching im Formular bearbeiten.
        </p>
      </div>
      <aside aria-labelledby="bilanz" className="flex w-full flex-col gap-2 lg:sticky lg:top-4 lg:w-72">
        <h3 id="bilanz" className="font-semibold">
          Deputatsbilanz
        </h3>
        {balance.length === 0 ? (
          <p className="text-sm text-muted">Betroffene Lehrkräfte erscheinen hier, sobald eine Zelle geändert ist – mit Soll am Stichtag und Lehraufträgen inkl. Änderungen.</p>
        ) : (
          <Table scrollLabel="Deputatsbilanz der betroffenen Lehrkräfte (Tabelle)">
            <caption className="sr-only">Deputatsbilanz der betroffenen Lehrkräfte</caption>
            <thead>
              <tr>
                <th scope="col">Lehrkraft</th>
                <th scope="col" className="text-right">
                  Soll
                </th>
                <th scope="col" className="text-right">
                  Lehraufträge
                </th>
                <th scope="col" className="text-right">
                  Rest
                </th>
              </tr>
            </thead>
            <tbody>
              {balance.map((b) => (
                <tr key={b.id}>
                  <td title={b.name}>{b.code ?? b.name}</td>
                  <td className="text-right tabular-nums">{num.format(b.target)}</td>
                  <td className="text-right tabular-nums">
                    {num.format(b.live)}
                    {b.delta !== 0 && (
                      <span className="block text-xs text-muted">
                        {b.delta > 0 ? "+" : "−"}
                        {num.format(Math.abs(b.delta))}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <Badge tone={b.rest === 0 ? "success" : b.rest > 0 ? "warn" : "danger"}>
                      {b.rest > 0 ? num.format(b.rest) : b.rest < 0 ? `−${num.format(-b.rest)}` : "±0"}
                      <span className="sr-only"> – {b.rest === 0 ? "ausgeglichen" : b.rest > 0 ? "unter Soll" : "über Soll"}</span>
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </aside>
    </div>
  );
}
