"use client";

import { useActionState, useTransition, useState } from "react";
import { addSlotsAction, checklistAction, decideAction, deleteSlotAction, moveSlotAction, noteAction, spamAction, verfahrenStepAction } from "@/modules/anmeldung/actions";
import { ANTRAG_STATUS_LABELS, OPTIONAL_FIELDS, OPTIONAL_FIELD_LABELS, VERFAHREN_KINDS, VERFAHREN_KIND_LABELS, type AntragStatus, type VerfahrenFields } from "@/modules/anmeldung/labels";
import type { SpamOp } from "@/modules/anmeldung/entscheidung";
import type { FormState } from "@/modules/verwaltung/actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

export interface VerfahrenFormValues {
  name: string;
  kind: string;
  targetSchoolYearId: string;
  targetGradeLevel: string;
  opensAt: string;
  closesAt: string;
  capacity: string;
  intro: string;
  rejectKeepDays: string;
  fields: VerfahrenFields;
}

function Message({ state, okText }: { state: FormState; okText?: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok && okText)
    return (
      <p role="status" className="text-sm text-success">
        {okText}
      </p>
    );
  return null;
}

/** Verfahren anlegen bzw. bearbeiten (Formular-Muster: Werte nach Fehler über `values` + key). */
export function VerfahrenForm({
  action,
  initial,
  years,
  grades,
  locked,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: VerfahrenFormValues;
  years: { id: string; name: string }[];
  grades: { level: number; name: string }[];
  /** Art und Ziel nach dem Veröffentlichen fest */
  locked?: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values;
  const val = (k: keyof Omit<VerfahrenFormValues, "fields">) => v?.[k] ?? initial[k];
  const checked = (f: (typeof OPTIONAL_FIELDS)[number]) => (v ? v[`field_${f}`] === "on" : initial.fields[f]);
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Verfahren" className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" hint="z. B. „Anmeldung Klasse 5 – Schuljahr 2027/28“" error={fe.name} className="sm:col-span-2">
        <Input name="name" defaultValue={val("name")} required maxLength={120} />
      </Field>
      <Field label="Art" error={fe.kind} hint={locked ? "Nach dem Veröffentlichen fest" : undefined}>
        <Select name="kind" defaultValue={val("kind")} disabled={locked}>
          {VERFAHREN_KINDS.map((k) => (
            <option key={k} value={k}>
              {VERFAHREN_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      {locked && <input type="hidden" name="kind" value={initial.kind} />}
      <Field label="Schuljahr" error={fe.targetSchoolYearId} hint="Fehlt das Schuljahr, unter Stammdaten anlegen">
        <Select name="targetSchoolYearId" defaultValue={val("targetSchoolYearId")} disabled={locked}>
          {years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </Select>
      </Field>
      {locked && <input type="hidden" name="targetSchoolYearId" value={initial.targetSchoolYearId} />}
      <Field label="Jahrgang" error={fe.targetGradeLevel}>
        <Select name="targetGradeLevel" defaultValue={val("targetGradeLevel")} disabled={locked}>
          {grades.map((g) => (
            <option key={g.level} value={String(g.level)}>
              {g.name}
            </option>
          ))}
        </Select>
      </Field>
      {locked && <input type="hidden" name="targetGradeLevel" value={initial.targetGradeLevel} />}
      <Field label="Plätze" hint="optional – nur zur Information bei der Entscheidung" error={fe.capacity}>
        <Input name="capacity" type="number" min={1} max={2000} defaultValue={val("capacity")} />
      </Field>
      <Field label="Anmeldung ab" error={fe.opensAt}>
        <Input name="opensAt" type="datetime-local" defaultValue={val("opensAt")} required />
      </Field>
      <Field label="Anmeldung bis" error={fe.closesAt}>
        <Input name="closesAt" type="datetime-local" defaultValue={val("closesAt")} required />
      </Field>
      <Field
        label="Hinweistext für Eltern"
        hint="Ablauf und mitzubringende Unterlagen – erscheint über dem Formular (kein HTML)"
        error={fe.intro}
        className="sm:col-span-2"
      >
        <Textarea name="intro" rows={6} maxLength={8000} defaultValue={val("intro")} />
      </Field>
      <fieldset className="flex flex-col gap-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Zusätzliche Angaben im Formular</legend>
        {OPTIONAL_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name={`field_${f}`} defaultChecked={checked(f)} className="size-4 accent-[var(--accent)]" />
            {OPTIONAL_FIELD_LABELS[f]}
          </label>
        ))}
        <p className="text-xs text-muted">Immer abgefragt: Name und Geburtsdatum des Kindes, Grundschule, Elternteil mit E-Mail, Anschrift, Gesprächstermin.</p>
      </fieldset>
      <Field
        label="Löschfrist abgelehnter Anträge (Tage)"
        hint="ab Abschluss des Verfahrens; Widerspruchsfrist 1 Monat + Puffer (31–365, Vorgabe 60)"
        error={fe.rejectKeepDays}
      >
        <Input name="rejectKeepDays" type="number" min={31} max={365} defaultValue={val("rejectKeepDays")} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : submitLabel}
        </Button>
        <Message state={state} okText="Gespeichert." />
      </div>
    </form>
  );
}

const STEP_LABELS = { veroeffentlichen: "Veröffentlichen", schliessen: "Anmeldung schließen", abschliessen: "Verfahren abschließen", loeschen: "Entwurf löschen" } as const;

/** Veröffentlichen, Schließen, Löschen – je nach Status. */
export function VerfahrenSteps({ id, steps }: { id: string; steps: (keyof typeof STEP_LABELS)[] }) {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {steps.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={s === "veroeffentlichen" ? "primary" : s === "loeschen" ? "danger" : "secondary"}
            disabled={pending}
            onClick={() =>
              start(async () => {
                if (s === "loeschen" && !confirm("Entwurf wirklich löschen?")) return;
                if (s === "abschliessen" && !confirm("Verfahren abschließen? Danach sind keine Entscheidungen mehr änderbar; die Löschfrist abgelehnter Anträge beginnt.")) return;
                setState(await verfahrenStepAction(id, s));
              })
            }
          >
            {STEP_LABELS[s]}
          </Button>
        ))}
      </div>
      <Message state={state} />
    </div>
  );
}

/** Gesprächstermine erzeugen: Tage × Zeitfenster × Dauer × parallele Gespräche. */
export function SlotGenerator({ id, rooms }: { id: string; rooms: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(addSlotsAction.bind(null, id), {});
  const fe = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Termine erzeugen" className="grid gap-4 sm:grid-cols-2">
      <Field label="Tage" hint="Datum je Zeile oder mit Komma getrennt, z. B. 2027-02-10, 2027-02-11" error={fe.days} className="sm:col-span-2">
        <Textarea name="days" rows={2} defaultValue={v?.days ?? ""} required />
      </Field>
      <Field label="Zeitfenster" hint="von–bis, mehrere mit Komma, z. B. 08:00-12:00, 14:00-17:00" error={fe.windows} className="sm:col-span-2">
        <Input name="windows" defaultValue={v?.windows ?? "14:00-17:00"} required />
      </Field>
      <Field label="Dauer je Gespräch (Minuten)" error={fe.durationMinutes}>
        <Input name="durationMinutes" type="number" min={5} max={240} defaultValue={v?.durationMinutes ?? "20"} required />
      </Field>
      <Field label="Pause dazwischen (Minuten)" error={fe.breakMinutes}>
        <Input name="breakMinutes" type="number" min={0} max={120} defaultValue={v?.breakMinutes ?? "0"} />
      </Field>
      <Field label="Parallele Gespräche" hint="z. B. 2, wenn zwei Personen gleichzeitig Gespräche führen" error={fe.parallel}>
        <Input name="parallel" type="number" min={1} max={50} defaultValue={v?.parallel ?? "1"} />
      </Field>
      <Field label="Raum" error={fe.roomId}>
        <Select name="roomId" defaultValue={v?.roomId ?? ""}>
          <option value="">– ohne –</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Erzeugen …" : "Termine erzeugen"}
        </Button>
        {state.ok && (
          <p role="status" className="text-sm text-success">
            {(state as { added?: number }).added ?? 0} Termine angelegt
            {(state as { skipped?: number }).skipped ? `, ${(state as { skipped?: number }).skipped} schon vorhanden` : ""}.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

export function SlotDelete({ verfahrenId, slotId, label }: { verfahrenId: string; slotId: string; label: string }) {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" aria-label={`Termin ${label} löschen`} disabled={pending} onClick={() => start(async () => setState(await deleteSlotAction(verfahrenId, slotId)))}>
        Löschen
      </Button>
      {state.error && (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      )}
    </span>
  );
}

/** Checkliste „vorgelegt“ im Gespräch (P4-36) – keine Uploads, nur Häkchen. */
export function ChecklistForm({ verfahrenId, antragId, items, checked }: { verfahrenId: string; antragId: string; items: { key: string; label: string }[]; checked: Record<string, boolean> }) {
  const [state, formAction, pending] = useActionState(checklistAction.bind(null, verfahrenId, antragId), {});
  return (
    <form action={formAction} aria-label="Unterlagen" className="flex flex-col gap-2">
      {items.map((c) => (
        <label key={c.key} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={`doc_${c.key}`} defaultChecked={checked[c.key] === true} className="size-4 accent-[var(--accent)]" />
          {c.label}
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Unterlagen speichern
        </Button>
        <Message state={state} okText="Gespeichert." />
      </div>
    </form>
  );
}

/** Interne Notiz (P4-36). */
export function NoteForm({ verfahrenId, antragId }: { verfahrenId: string; antragId: string }) {
  const [state, formAction, pending] = useActionState(noteAction.bind(null, verfahrenId, antragId), {});
  return (
    <form key={state.ok ? "ok" : JSON.stringify(state.values ?? null)} action={formAction} aria-label="Notiz" className="flex flex-col gap-2">
      <Field label="Notiz (intern)" hint="Nur für Sekretariat und Schulleitung sichtbar – bitte keine Gesundheitsdaten" error={state.fieldErrors?.note}>
        <Textarea name="note" rows={3} maxLength={1000} defaultValue={state.values?.note ?? ""} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Notiz speichern
        </Button>
        <Message state={state} okText="Notiz gespeichert." />
      </div>
    </form>
  );
}

/** Termin verschieben (P4-36): freie Termine + aktueller; leer = ohne Termin. Eltern bekommen eine Mail. */
export function MoveSlotForm({ verfahrenId, antragId, current, options }: { verfahrenId: string; antragId: string; current: string | null; options: { id: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(moveSlotAction.bind(null, verfahrenId, antragId), {});
  return (
    <form action={formAction} aria-label="Termin verschieben" className="flex flex-wrap items-end gap-3">
      <Field label="Gesprächstermin" hint="Eltern bekommen eine Mail">
        <Select name="slotId" defaultValue={current ?? ""} className="w-72">
          <option value="">– ohne Termin –</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={pending}>
        Termin speichern
      </Button>
      <Message state={state} okText="Termin gespeichert." />
    </form>
  );
}

const DECISION_BUTTONS = [
  { value: "aufgenommen", label: "Aufnehmen", variant: "primary" },
  { value: "warteliste", label: "Warteliste", variant: "secondary" },
  { value: "abgelehnt", label: "Ablehnen", variant: "danger" },
] as const;

function DecisionResult({ state }: { state: FormState & { changed?: number; mails?: number } }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.error}
      </p>
    );
  if (!state.ok) return null;
  return (
    <p role="status" className="text-sm text-success">
      {state.changed === 1 ? "1 Antrag entschieden" : `${state.changed ?? 0} Anträge entschieden`}
      {state.mails ? ` – ${state.mails === 1 ? "1 Mail" : `${state.mails} Mails`} „Bescheid folgt per Post“ verschickt` : ""}.
    </p>
  );
}

export interface DecisionListRow {
  id: string;
  number: string;
  child: string;
  birth: string;
  school: string;
  /** null = kein Geschwisterkind; sonst Hinweis (Name/Klasse) bzw. „ja“ */
  sibling: string | null;
  place: string;
  status: AntragStatus;
  documentsComplete: boolean;
  href: string;
}

/**
 * Entscheidung als Liste (P4-37): Auswahl per Häkchen, dann für alle Ausgewählten „Aufnehmen“/„Warteliste“/„Ablehnen“.
 * Kapazität und „danach frei“ rechnet die Seite nur zur Information mit – sie verhindert nichts und wählt nichts aus (Q-34).
 */
export function DecisionList({
  verfahrenId,
  rows,
  capacity,
  admitted,
  canDecide,
  lateAdmission = false,
}: {
  verfahrenId: string;
  rows: DecisionListRow[];
  capacity: number | null;
  admitted: number;
  canDecide: boolean;
  /** Q5-19: Verfahren abgeschlossen – nur noch Nachrücken von der Warteliste (bis Schuljahresbeginn) */
  lateAdmission?: boolean;
}) {
  const [state, formAction, pending] = useActionState(decideAction.bind(null, verfahrenId, null), {});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const newlyAdmitted = rows.filter((r) => selected.has(r.id) && r.status !== "aufgenommen").length;
  const selectable = lateAdmission ? rows.filter((r) => r.status === "warteliste") : rows;
  const all = selectable.length > 0 && selected.size === selectable.length;
  const buttons = lateAdmission ? DECISION_BUTTONS.filter((b) => b.value === "aufgenommen") : DECISION_BUTTONS;
  return (
    <form action={formAction} aria-label="Entscheidung" className="flex flex-col gap-4">
      {canDecide && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface-2 p-3">
          <p className="text-sm" data-testid="auswahl">
            {selected.size === 1 ? "1 Antrag ausgewählt" : `${selected.size} Anträge ausgewählt`}
            {capacity !== null && (
              <span className="text-muted">
                {" "}
                · Plätze {capacity}, aufgenommen {admitted}
                {newlyAdmitted > 0 && `, nach dem Aufnehmen frei ${capacity - admitted - newlyAdmitted}`}
              </span>
            )}
          </p>
          <Field label="Notiz zur Entscheidung (intern, optional)" className="min-w-64 flex-1">
            <Input name="note" maxLength={1000} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {buttons.map((b) => (
              <Button key={b.value} type="submit" name="decision" value={b.value} size="sm" variant={b.variant} disabled={pending || selected.size === 0}>
                {b.label}
              </Button>
            ))}
          </div>
          {capacity !== null && newlyAdmitted > 0 && capacity - admitted - newlyAdmitted < 0 && (
            <p role="note" className="basis-full text-sm text-danger">
              Mit dieser Auswahl wären mehr Kinder aufgenommen als Plätze vorgesehen – nur ein Hinweis, die Entscheidung trifft die Schulleitung.
            </p>
          )}
          <div className="basis-full">
            <DecisionResult state={state} />
          </div>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            {canDecide && (
              <th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Alle auswählen"
                  checked={all}
                  onChange={() => setSelected(all ? new Set() : new Set(selectable.map((r) => r.id)))}
                  className="size-4 accent-[var(--accent)]"
                />
              </th>
            )}
            <th>Nummer</th>
            <th>Kind</th>
            <th>Grundschule</th>
            <th>Hinweise (nur Information)</th>
            <th>Unterlagen</th>
            <th>Stand</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {canDecide && (
                <td>
                  {(!lateAdmission || r.status === "warteliste") && (
                    <input
                      type="checkbox"
                      name="antrag"
                      value={r.id}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`${r.child} auswählen`}
                      className="size-4 accent-[var(--accent)]"
                    />
                  )}
                </td>
              )}
              <td className="tabular-nums">{r.number}</td>
              <td>
                <a href={r.href} className="font-medium hover:underline">
                  {r.child}
                </a>
                <span className="block text-xs text-muted tabular-nums">{r.birth}</span>
              </td>
              <td>{r.school || "–"}</td>
              <td className="text-sm">
                {r.sibling && <span className="block">Geschwisterkind{r.sibling !== "ja" ? `: ${r.sibling}` : ""}</span>}
                <span className="block text-muted">Wohnort: {r.place || "–"}</span>
              </td>
              <td>{r.documentsComplete ? "vollständig" : <span className="text-muted">offen</span>}</td>
              <td>{ANTRAG_STATUS_LABELS[r.status]}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </form>
  );
}

/** Entscheidung für einen Antrag (Antragsseite). */
export function DecideOneForm({
  verfahrenId,
  antragId,
  current,
  lateAdmission = false,
}: {
  verfahrenId: string;
  antragId: string;
  current: AntragStatus;
  /** Q5-19: nur „Aufnehmen“ (Nachrücken nach Abschluss) */
  lateAdmission?: boolean;
}) {
  const [state, formAction, pending] = useActionState(decideAction.bind(null, verfahrenId, antragId), {});
  return (
    <form action={formAction} aria-label="Entscheidung" className="flex flex-col gap-3">
      <Field label="Notiz zur Entscheidung (intern, optional)" hint="Bitte keine Gesundheitsdaten">
        <Textarea name="note" rows={2} maxLength={1000} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {DECISION_BUTTONS.filter((b) => b.value !== current && (!lateAdmission || b.value === "aufgenommen")).map((b) => (
          <Button key={b.value} type="submit" name="decision" value={b.value} size="sm" variant={b.variant} disabled={pending}>
            {b.label}
          </Button>
        ))}
      </div>
      <DecisionResult state={state} />
    </form>
  );
}

export interface AntragListViewRow {
  id: string;
  number: string;
  href: string;
  child: string;
  sibling: boolean;
  viaAccount: boolean;
  birth: string;
  school: string;
  slot: string;
  status: AntragStatus;
  spam: boolean;
  /** P4-78b: Spam-Verdacht (Sekretariat) */
  spamSuspect: boolean;
}

/** P4-78: so viele Stände lassen sich als Spam ablehnen bzw. markieren (offen und bestätigt) */
const SPAM_SELECTABLE: readonly AntragStatus[] = ["eingegangen", "termin", "vollstaendig"];
/** G4D-S04: Anträge aus einem Elternkonto sind nie Spam – sie werden regulär entschieden. */
const spamSelectable = (r: Pick<AntragListViewRow, "status" | "viaAccount">) => SPAM_SELECTABLE.includes(r.status) && !r.viaAccount;

const SPAM_DONE: Record<SpamOp, (n: number) => string> = {
  ablehnen: (n) => (n === 1 ? "1 Antrag als Spam abgelehnt." : `${n} Anträge als Spam abgelehnt.`),
  markieren: (n) => (n === 1 ? "1 Antrag als Spam-Verdacht markiert." : `${n} Anträge als Spam-Verdacht markiert.`),
  zuruecknehmen: (n) => (n === 1 ? "Spam-Verdacht bei 1 Antrag zurückgenommen." : `Spam-Verdacht bei ${n} Anträgen zurückgenommen.`),
};

/**
 * Antragsliste (P4-36) mit Spam-Schritten (P4-78, P4-78b – zweistufig): Wer markieren darf (`anmeldung.spam`, Vorgabe
 * Sekretariat), setzt Häkchen und markiert „Spam-Verdacht“ bzw. nimmt ihn zurück – ohne Mail, der Stand bleibt. Wer
 * entscheidet (`anmeldung.decide`), bestätigt mit „Als Spam ablehnen“ (Rückfrage, keine Mail, Grund „Spam“). Nur offene Anträge.
 */
export function AntragTable({ verfahrenId, rows, canSpam, canMark }: { verfahrenId: string; rows: AntragListViewRow[]; canSpam: boolean; canMark: boolean }) {
  const [state, formAction, pending] = useActionState(spamAction.bind(null, verfahrenId), {});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const any = canSpam || canMark;
  const selectable = any ? rows.filter(spamSelectable) : [];
  const suspects = selectable.filter((r) => r.spamSuspect);
  const all = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = selectable.filter((r) => selected.has(r.id));
  const count = (n: number) => (n === 1 ? "1 Antrag" : `${n} Anträge`);
  return (
    <form
      action={(fd) => {
        setSelected(new Set());
        formAction(fd);
      }}
      onSubmit={(e) => {
        const op = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value as SpamOp | undefined;
        if (op === "ablehnen" && !confirm(`${count(chosen.length)} als Spam ablehnen? An die angegebenen Adressen geht keine Mail.`)) e.preventDefault();
      }}
      aria-label="Anträge"
      className="flex flex-col gap-3"
    >
      {canSpam && suspects.length > 0 && (
        <p className="rounded-xl border border-warn-border bg-warn-soft p-3 text-sm text-warn" data-testid="spam-verdacht-hinweis">
          {suspects.length === 1 ? "1 Antrag ist" : `${suspects.length} Anträge sind`} als Spam-Verdacht markiert – prüfen und als Spam ablehnen oder die
          Markierung zurücknehmen.{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => setSelected(new Set(suspects.map((r) => r.id)))}>
            Alle mit Spam-Verdacht auswählen
          </button>
        </p>
      )}
      {any && (selectable.length > 0 || state.ok || state.error) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
          <p className="text-sm" data-testid="spam-auswahl">
            {chosen.length === 1 ? "1 Antrag ausgewählt" : `${chosen.length} Anträge ausgewählt`}
          </p>
          {canMark && (
            <>
              <Button type="submit" name="op" value="markieren" size="sm" disabled={pending || chosen.length === 0}>
                Als Spam-Verdacht markieren
              </Button>
              <Button type="submit" name="op" value="zuruecknehmen" size="sm" variant="ghost" disabled={pending || !chosen.some((r) => r.spamSuspect)}>
                Markierung zurücknehmen
              </Button>
            </>
          )}
          {canSpam && (
            <Button type="submit" name="op" value="ablehnen" size="sm" variant="danger" disabled={pending || chosen.length === 0}>
              Als Spam ablehnen
            </Button>
          )}
          <span className="text-xs text-muted">
            {canSpam
              ? "Ablehnen: ohne Mail an die Adresse, Grund „Spam“, im Protokoll. Nur offene Anträge."
              : "Markieren ändert den Stand nicht und schickt keine Mail – ablehnen bestätigt die Schulleitung. Nur offene Anträge."}
          </span>
          {state.error && (
            <p role="alert" className="basis-full text-sm text-danger">
              {state.error}
            </p>
          )}
          {state.ok && (
            <p role="status" className="basis-full text-sm text-success">
              {SPAM_DONE[state.op ?? "ablehnen"](state.changed ?? 0)}
            </p>
          )}
        </div>
      )}
      <Table>
        <thead>
          <tr>
            {any && selectable.length > 0 && (
              <th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Alle offenen auswählen"
                  checked={all}
                  onChange={() => setSelected(all ? new Set() : new Set(selectable.map((r) => r.id)))}
                  className="size-4 accent-[var(--accent)]"
                />
              </th>
            )}
            <th>Nummer</th>
            <th>Kind</th>
            <th>Geburtsdatum</th>
            <th>Grundschule</th>
            <th>Termin</th>
            <th>Stand</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              {any && selectable.length > 0 && (
                <td>
                  {spamSelectable(a) && (
                    <input
                      type="checkbox"
                      name="antrag"
                      value={a.id}
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                      aria-label={`${a.child} auswählen`}
                      className="size-4 accent-[var(--accent)]"
                    />
                  )}
                </td>
              )}
              <td className="tabular-nums">{a.number}</td>
              <td>
                <a href={a.href} className="font-medium hover:underline">
                  {a.child}
                </a>
                {a.sibling && <span className="ml-2 text-xs text-muted">Geschwister</span>}
                {a.viaAccount && <span className="ml-2 text-xs text-muted">Elternkonto</span>}
              </td>
              <td className="tabular-nums">{a.birth}</td>
              <td>{a.school || "–"}</td>
              <td className="tabular-nums">{a.slot || "–"}</td>
              <td>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={a.status === "vollstaendig" ? "success" : a.status === "unbestaetigt" ? "warn" : a.spam ? "danger" : "soft"}>
                    {ANTRAG_STATUS_LABELS[a.status]}
                    {a.spam && " (Spam)"}
                  </Badge>
                  {a.spamSuspect && SPAM_SELECTABLE.includes(a.status) && <Badge tone="warn">Spam-Verdacht</Badge>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </form>
  );
}
