"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Segmented, Select, Textarea } from "@schulos/ui/field";

type Kind = "version" | "teacher" | "group" | "slot";
type Option = { id: string; label: string };

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"] as const;

/** SP3-03: Kommentar der Planung/Prüfung an eine Version – Bezug ganze Version, Lehrkraft, Klasse/Kurs oder Stunde. */
export function CommentForm({
  action,
  teachers,
  groups,
  periods,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  teachers: Option[];
  groups: Option[];
  periods: { nr: number; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const [kind, setKind] = useState<Kind>((v.targetKind as Kind | undefined) ?? "version");
  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} aria-label="Kommentar schreiben" className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <Segmented
        legend="Bezug"
        name="targetKind"
        value={kind}
        onChange={setKind}
        options={[
          { value: "version", label: "Ganze Version" },
          { value: "teacher", label: "Lehrkraft" },
          { value: "group", label: "Klasse/Kurs" },
          { value: "slot", label: "Stunde" },
        ]}
      />
      {kind !== "version" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kind === "teacher" && (
            <Field label="Lehrkraft" error={fe.teacherId}>
              <Select name="teacherId" defaultValue={v.teacherId ?? teachers[0]?.id} required>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === "slot" && (
            <>
              <Field label="Wochentag" error={fe.weekday}>
                <Select name="weekday" defaultValue={v.weekday ?? "0"}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Stunde" error={fe.periodNr}>
                <Select name="periodNr" defaultValue={v.periodNr ?? String(periods[0]?.nr ?? 1)}>
                  {periods.map((p) => (
                    <option key={p.nr} value={p.nr}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {(kind === "group" || kind === "slot") && (
            <Field label={kind === "slot" ? "Klasse/Kurs (optional)" : "Klasse/Kurs"} error={fe.groupId}>
              <Select name="groupId" defaultValue={v.groupId ?? (kind === "group" ? groups[0]?.id : "")} required={kind === "group"}>
                {kind === "slot" && <option value="">– alle –</option>}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      <Field label="Kommentar" hint="höchstens 500 Zeichen – keine Gesundheitsangaben, Personen nur, soweit für den Plan nötig" error={fe.body}>
        <Textarea name="body" rows={3} maxLength={500} required defaultValue={v.body ?? ""} />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          Kommentar speichern
        </Button>
      </div>
    </form>
  );
}
