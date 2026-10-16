"use client";

import { useState, useTransition } from "react";
import {
  addColumnAction,
  addExamColumnAction,
  deleteColumnAction,
  moveColumnAction,
  setWeightsAction,
  updateColumnAction,
} from "@/modules/notenbuch/actions";
import { COLUMN_KIND_LABELS, COLUMN_KINDS, defaultKey, weightsSum, type ColumnKind, type GradeKey, type Scale, type Weights } from "@/modules/notenbuch/berechnung";
import type { ColumnInput } from "@/modules/notenbuch/service";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import type { TableColumn } from "./tabelle";

function Status({ state, saved }: { state: FormState; saved?: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger sm:col-span-full">
        {state.error}
      </p>
    );
  if (state.ok && saved)
    return (
      <p role="status" className="text-sm text-success sm:col-span-full">
        {saved}
      </p>
    );
  return null;
}

const sameKey = (a: GradeKey, b: GradeKey) => a.length === b.length && a.every((s, i) => s.grade === b[i]!.grade && s.min === b[i]!.min);

/** Spalte anlegen bzw. bearbeiten: Titel, Art, Datum, Gewicht, optional Höchstpunktzahl mit Notenschlüssel (Punkte → Note). */
function ColumnForm({
  scale,
  initial,
  label,
  submitLabel,
  onSubmit,
  onDone,
}: {
  scale: Scale;
  initial?: TableColumn;
  label: string;
  submitLabel: string;
  onSubmit: (input: ColumnInput) => Promise<FormState>;
  onDone?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [kind, setKind] = useState<ColumnKind>(initial?.kind ?? "sonstige");
  const [date, setDate] = useState(initial?.date ?? "");
  const [weight, setWeight] = useState(String(initial?.weight ?? 100));
  const [maxPoints, setMaxPoints] = useState(initial?.maxPoints != null ? String(initial.maxPoints).replace(".", ",") : "");
  const [key, setKey] = useState<{ grade: string; min: string }[]>((initial?.key ?? defaultKey(scale)).map((s) => ({ grade: s.grade, min: String(s.min) })));
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  const fe = state.fieldErrors ?? {};
  const withPoints = maxPoints.trim() !== "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const k: GradeKey = key.map((s) => ({ grade: s.grade, min: Number(s.min.replace(",", ".")) }));
    const input: ColumnInput = {
      kind,
      title,
      date: date || null,
      weight: Number(weight),
      maxPoints: withPoints ? Number(maxPoints.replace(",", ".")) : null,
      key: withPoints && !sameKey(k, defaultKey(scale)) ? k : null,
    };
    start(async () => {
      const res = await onSubmit(input);
      setState(res);
      if (res.ok && !initial) {
        setTitle("");
        setDate("");
        setWeight("100");
        setMaxPoints("");
      }
      if (res.ok) onDone?.();
    });
  };

  return (
    <form aria-label={label} onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Field label="Titel" error={fe.title} className="lg:col-span-2">
        <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Art" error={fe.kind}>
        <Select value={kind} onChange={(e) => setKind(e.target.value as ColumnKind)}>
          {COLUMN_KINDS.map((k) => (
            <option key={k} value={k}>
              {COLUMN_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Datum" hint="optional" error={fe.date}>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Gewicht" hint="innerhalb der Art: 100 = einfach, 200 = doppelt, 0 = zählt nicht" error={fe.weight}>
        <Input type="number" min={0} max={1000} step={1} value={weight} onChange={(e) => setWeight(e.target.value)} />
      </Field>
      <Field label="Höchstpunktzahl" hint="optional – dann Punkte eintragen, die Note ergibt sich aus dem Schlüssel" error={fe.maxPoints} className="lg:col-span-2">
        <Input inputMode="decimal" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} />
      </Field>
      {withPoints && (
        <fieldset className="flex flex-col gap-2 sm:col-span-full">
          <legend className="text-sm font-medium">Notenschlüssel (ab … % der Höchstpunktzahl)</legend>
          <div className="flex flex-wrap gap-2">
            {key.map((s, i) => (
              <label key={s.grade} className="flex items-center gap-1 text-sm">
                <span className="w-6 text-right font-semibold">{s.grade}</span>
                <Input
                  aria-label={`Note ${s.grade} ab Prozent`}
                  className="h-9 w-16 px-2 text-sm"
                  inputMode="decimal"
                  value={s.min}
                  onChange={(e) => setKey(key.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))}
                />
                <span className="text-muted">%</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">
            Vorgabe angelehnt an die Prozentgrenzen der Abiturprüfung – je Spalte änderbar.{" "}
            <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => setKey(defaultKey(scale).map((s) => ({ grade: s.grade, min: String(s.min) })))}>
              Vorgabe wiederherstellen
            </button>
          </p>
          {fe.key && <p className="text-sm text-danger">{fe.key}</p>}
        </fieldset>
      )}
      <div className="flex items-end gap-2 sm:col-span-full">
        <Button type="submit" variant="primary" disabled={pending}>
          {submitLabel}
        </Button>
        {onDone && initial && (
          <Button variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
        )}
      </div>
      <Status state={state} saved={initial ? undefined : "Spalte angelegt."} />
    </form>
  );
}

/** Spalten verwalten (P5-12): anlegen, aus dem Klausurplan übernehmen, bearbeiten, umsortieren, löschen. */
export function ColumnManager({
  bookId,
  scale,
  columns,
  exams,
  counts,
  locked,
}: {
  bookId: string;
  scale: Scale;
  columns: TableColumn[];
  exams: { id: string; title: string; date: string }[];
  /** Anzahl Einträge je Spalte (für die Rückfrage beim Löschen) */
  counts: Record<string, number>;
  locked: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [chosenExam, setExamId] = useState(exams[0]?.id ?? "");
  const examId = exams.some((x) => x.id === chosenExam) ? chosenExam : (exams[0]?.id ?? "");
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormState>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setState(res);
      if (res.ok) after?.();
    });

  if (locked)
    return (
      <ul className="flex flex-col gap-1 text-sm">
        {columns.map((c) => (
          <li key={c.id}>
            {c.title} <span className="text-muted">· {COLUMN_KIND_LABELS[c.kind]}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="flex flex-col gap-6">
      {columns.length > 0 && (
        <ul className="rounded-card border border-border px-4" aria-label="Spalten">
          {columns.map((c, i) => (
            <li key={c.id} className="flex flex-col gap-3 border-t border-border py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-medium">{c.title}</span>
                <span className="text-sm text-muted">
                  {COLUMN_KIND_LABELS[c.kind]} · Gewicht {c.weight}
                  {c.maxPoints !== null && ` · ${String(c.maxPoints).replace(".", ",")} Punkte`}
                  {c.date && ` · ${c.date.split("-").reverse().join(".")}`}
                </span>
                <span className="ml-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" aria-label={`${c.title} nach links`} disabled={pending || i === 0} onClick={() => run(() => moveColumnAction(bookId, c.id, -1))}>
                    ←
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${c.title} nach rechts`}
                    disabled={pending || i === columns.length - 1}
                    onClick={() => run(() => moveColumnAction(bookId, c.id, 1))}
                  >
                    →
                  </Button>
                  <Button size="sm" aria-expanded={editing === c.id} onClick={() => setEditing(editing === c.id ? null : c.id)}>
                    Bearbeiten
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(confirm === c.id ? null : c.id)}>
                    Löschen
                  </Button>
                </span>
              </div>
              {confirm === c.id && (
                <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                  <span>
                    „{c.title}“ mit {counts[c.id] ?? 0} {counts[c.id] === 1 ? "Eintrag" : "Einträgen"} löschen? Das lässt sich nicht rückgängig machen.
                  </span>
                  <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => deleteColumnAction(bookId, c.id), () => setConfirm(null))}>
                    Spalte löschen
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    Abbrechen
                  </Button>
                </div>
              )}
              {editing === c.id && (
                <ColumnForm
                  scale={scale}
                  initial={c}
                  label={`Spalte ${c.title} bearbeiten`}
                  submitLabel="Spalte speichern"
                  onSubmit={(input) => updateColumnAction(bookId, c.id, input)}
                  onDone={() => setEditing(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Status state={state} />
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Neue Spalte</h3>
        <ColumnForm scale={scale} label="Neue Spalte" submitLabel="Spalte anlegen" onSubmit={(input) => addColumnAction(bookId, input)} />
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Aus dem Klausurplan</h3>
        {exams.length === 0 ? (
          <p className="text-sm text-muted">Im Klausurplan steht für diese Lerngruppe, dieses Fach und Halbjahr kein (weiterer) Termin.</p>
        ) : (
          <form
            aria-label="Spalte aus dem Klausurplan"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => addExamColumnAction(bookId, examId));
            }}
          >
            <Field label="Termin">
              <Select value={examId} onChange={(e) => setExamId(e.target.value)}>
                {exams.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} ({x.date.split("-").reverse().join(".")})
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={pending}>
              Als Spalte übernehmen
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Gewichte je Spaltenart in % (P5-12) – Hinweis, wenn sie nicht 100 % ergeben. */
export function WeightsForm({ bookId, weights, locked }: { bookId: string; weights: Weights; locked: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(COLUMN_KINDS.map((k) => [k, String(weights[k] ?? 0)])));
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  const parsed: Weights = Object.fromEntries(COLUMN_KINDS.map((k) => [k, Number(values[k] || 0)]));
  const sum = weightsSum(parsed);
  return (
    <form
      aria-label="Gewichtung"
      className="grid gap-4 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await setWeightsAction(bookId, parsed)));
      }}
    >
      {COLUMN_KINDS.map((k) => (
        <Field key={k} label={`${COLUMN_KIND_LABELS[k]} (%)`} error={state.fieldErrors?.weights && k === "schriftlich" ? state.fieldErrors.weights : undefined}>
          <Input type="number" min={0} max={100} step={1} disabled={locked} value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
        </Field>
      ))}
      <div className="flex items-end">
        <Button type="submit" disabled={pending || locked}>
          Gewichte speichern
        </Button>
      </div>
      <p className={sum === 100 ? "text-xs text-muted sm:col-span-full" : "text-sm text-warn sm:col-span-full"}>
        Zusammen {sum} %{sum !== 100 && " – erlaubt, der Vorschlag rechnet mit den Anteilen; üblich sind 100 %"}. Nach dem Speichern wird der Vorschlag aller
        Schüler:innen neu berechnet.
      </p>
      <Status state={state} saved="Gewichte gespeichert." />
    </form>
  );
}
