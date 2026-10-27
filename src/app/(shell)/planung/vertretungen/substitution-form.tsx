"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Segmented, Select } from "@schulos/ui/field";

interface Teacher {
  id: string;
  label: string;
  free: boolean;
}

/** VT-03b: Art als Segment-Schalter; „Betreuung“ ist eine Vertretung mit dem Merkmal „nur Betreuung“ (F-10-9). */
type Art = "substitute" | "supervision" | "cancel" | "room" | "move" | "merge";
const ARTS: { value: Art; label: string }[] = [
  { value: "substitute", label: "Vertretung" },
  { value: "supervision", label: "Nur Betreuung" },
  { value: "cancel", label: "Entfall" },
  { value: "room", label: "Raumänderung" },
  { value: "move", label: "Verlegung" },
  { value: "merge", label: "Zusammenlegung" },
];
const artOf = (kind: string, supervisionOnly: string): Art => (kind === "substitute" && supervisionOnly === "1" ? "supervision" : ((kind || "substitute") as Art));

export function SubstitutionForm({
  action,
  removeAction,
  lessonId,
  date,
  label,
  initial,
  teachers,
  rooms,
  subjects,
  regularSubjectId,
  exams,
  periods,
  ownPeriod,
  mergeOptions,
  permanent,
  reasons,
  defaultReasonLabel,
  nextHref,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  removeAction?: () => Promise<void>;
  lessonId: string;
  date: string;
  /** z. B. „3. Std · Mathematik · Klasse 7b“ – für eindeutige Feldnamen */
  label: string;
  initial: {
    kind: string;
    substituteId: string;
    roomId: string;
    note: string;
    subjectId: string;
    targetPeriod: string;
    mergeLessonId: string;
    /** VT-01: gespeicherte Kategorie („“ = automatisch), interne Notiz, „1“ = nur Betreuung */
    reason: string;
    internalNote: string;
    supervisionOnly: string;
  };
  /** VT-01: Grund-Kategorien zur Auswahl und die Vorgabe für diese Stunde (Anzeige bei „automatisch“) */
  reasons: { value: string; label: string }[];
  defaultReasonLabel?: string | null;
  teachers: Teacher[];
  rooms: { id: string; label: string }[];
  /** SP-12 (Fachtausch): alle Fächer; Vorgabe ist das reguläre Fach der Stunde */
  subjects: { id: string; label: string }[];
  regularSubjectId: string;
  /** Arbeiten der Gruppe an dem Tag – Hinweis, wenn das gewählte Fach eine hat */
  exams: { subjectId: string; label: string }[];
  /** SP2-07 Verlegung: Stunden des Zeitrasters; die eigene ist nicht wählbar */
  periods: { nr: number; label: string }[];
  ownPeriod: number;
  /** SP2-07 Zusammenlegung: Stunden zur selben Zeit */
  mergeOptions: { lessonId: string; label: string }[];
  /** SP2-08 Dauervertretung: mehrtägige Abwesenheit der Lehrkraft – „bis“ als Anzeige (TT.MM.) */
  permanent?: { absenceId: string; until: string };
  /** VT-03b: Ziel nach dem Speichern (nächste offene Stunde); leer = in der Stunde bleiben */
  nextHref?: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, {});
  const v = { ...initial, ...state.values };
  const [art, setArt] = useState<Art>(artOf(v.kind, v.supervisionOnly));
  const [subjectId, setSubjectId] = useState(v.subjectId || regularSubjectId);
  // key: nach dem Speichern liefert der Server neue Werte → Formular neu aufbauen (React setzt es sonst auf alte Vorgaben zurück).
  // Art und Fach sind Zustand dieser Komponente, nicht des Formulars – die setzt der key nicht zurück; z. B. stand nach
  // „Lehrkraft mit eigenem Fach übernehmen“ weiter das reguläre Fach im Feld, und Speichern hätte den Fachtausch aufgehoben
  const formKey = JSON.stringify([initial, state.values ?? null]);
  const [seenKey, setSeenKey] = useState(formKey);
  if (seenKey !== formKey) {
    setSeenKey(formKey);
    setArt(artOf(v.kind, v.supervisionOnly));
    setSubjectId(v.subjectId || regularSubjectId);
  }
  // VT-03b: nach dem Speichern weiter zur nächsten offenen Stunde (ohne weitere offene bleibt die Stunde stehen)
  useEffect(() => {
    if (state.ok && nextHref) router.push(nextHref);
  }, [state, nextHref, router]);
  const kind = art === "supervision" ? "substitute" : art;
  const withTeacher = kind === "substitute";
  const exam = art === "substitute" ? exams.find((e) => e.subjectId === subjectId) : undefined;
  const fe = state.fieldErrors ?? {};
  return (
    <form key={formKey} action={formAction} aria-label={label} className="flex flex-col gap-3">
      <input type="hidden" name="lessonId" value={lessonId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="kind" value={kind} />
      {art === "supervision" && <input type="hidden" name="supervisionOnly" value="1" />}
      <Segmented legend="Art" name="art" value={art} onChange={setArt} options={ARTS} />
      {fe.kind && (
        <p role="alert" className="-mt-2 text-xs text-danger">
          {fe.kind}
        </p>
      )}
      <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
        {withTeacher && (
          <Field label="Vertretung durch" error={fe.substituteId}>
            <Select name="substituteId" defaultValue={v.substituteId}>
              <option value="">Lehrkraft wählen</option>
              <optgroup label="Frei">
                {teachers
                  .filter((t) => t.free)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Hat selbst Unterricht">
                {teachers
                  .filter((t) => !t.free)
                  .map((t) => (
                    <option key={t.id} value={t.id} disabled>
                      {t.label}
                    </option>
                  ))}
              </optgroup>
            </Select>
          </Field>
        )}
        {art === "substitute" && (
          <Field label="Fach" error={fe.subjectId}>
            <Select name="subjectId" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id === regularSubjectId ? `${x.label} (regulär)` : x.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind !== "cancel" && kind !== "merge" && (
          <Field label="Raum" error={fe.roomId}>
            <Select name="roomId" defaultValue={v.roomId}>
              <option value="">wie sonst</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "move" && (
          <>
            <Field label="Verlegen in" error={fe.targetPeriod}>
              <Select name="targetPeriod" defaultValue={v.targetPeriod}>
                <option value="">Stunde wählen</option>
                {periods
                  .filter((p) => p.nr !== ownPeriod)
                  .map((p) => (
                    <option key={p.nr} value={p.nr}>
                      {p.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input type="checkbox" name="swap" value="1" className="size-4 accent-[var(--accent)]" />
              Tauschen: Unterricht der Gruppe aus der Zielstunde rückt hierher
            </label>
          </>
        )}
        {kind === "merge" && (
          <Field label="Zusammenlegen mit" error={fe.mergeLessonId} className="@xl:col-span-2">
            <Select name="mergeLessonId" defaultValue={v.mergeLessonId}>
              <option value="">Stunde zur selben Zeit wählen</option>
              {mergeOptions.map((o) => (
                <option key={o.lessonId} value={o.lessonId}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {/* öffentlicher Grund (grob), Hinweis für Schüler:innen, interner Hinweis (nur Planung und Vertretung) */}
      <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
        <Field label="Grund (öffentlich)" error={fe.reason}>
          <Select name="reason" defaultValue={v.reason}>
            <option value="">{defaultReasonLabel ? `automatisch (${defaultReasonLabel})` : "automatisch"}</option>
            {reasons.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hinweis für Schüler:innen" error={fe.note}>
          <Input name="note" defaultValue={v.note} placeholder="z. B. Arbeitsheft S. 24" maxLength={200} />
        </Field>
        <Field label="Interne Notiz (nur Planung und Vertretung)" error={fe.internalNote}>
          <Input name="internalNote" defaultValue={v.internalNote} placeholder="keine Gesundheitsangaben" maxLength={300} />
        </Field>
      </div>
      {withTeacher && permanent && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="permanent" value={permanent.absenceId} className="size-4 accent-[var(--accent)]" />
          Dauervertretung: für alle Tage der Abwesenheit (bis {permanent.until}) – einzelne Tage lassen sich danach ändern
        </label>
      )}
      {exam && (
        <p role="note" className="text-sm font-medium text-warn">
          Achtung: An diesem Tag steht für die Gruppe eine {exam.label} an.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : "Speichern"}
        </Button>
        {removeAction && (
          <Button type="submit" formAction={removeAction} formNoValidate>
            Aufheben
          </Button>
        )}
        {nextHref && <span className="text-xs text-muted">Danach geht es mit der nächsten offenen Stunde weiter.</span>}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.message ?? "Gespeichert – Betroffene sind benachrichtigt."}
        </p>
      )}
    </form>
  );
}
