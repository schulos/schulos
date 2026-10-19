"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { decideAbsence, reportOwnAbsence, saveMaterial, withdrawOwnAbsence } from "./selbstmeldung";

// P4-74/Q5-12: Abwesenheit selbst melden, zurückziehen, genehmigen; Vertretungsmaterial speichern. Rechte prüft der Service
// (Lehrkraft selbst, `stundenplan.absence_approve`, `stundenplan.substitute`); das Modul muss eingeschaltet sein.
const { requireUser } = moduleActions("stundenplan");
const PAGE = "/stundenplan/abwesenheit";
const today = () => toBerlinDate(new Date());

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError)
    return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: form ? formValues(form) : undefined };
  throw err;
}

export async function reportOwnAbsenceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const period = (k: string) => (str(k) ? Number(str(k)) : null);
  let status: string;
  try {
    status = (
      await reportOwnAbsence(
        await getDb(),
        perms,
        {
          startsOn: str("startsOn"),
          endsOn: str("endsOn") || str("startsOn"),
          fromPeriod: period("fromPeriod"),
          toPeriod: period("toPeriod"),
          reason: str("reason"),
          note: str("note") || null,
        },
        today(),
      )
    ).status;
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true, values: { status } };
}

export async function withdrawOwnAbsenceAction(id: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await withdrawOwnAbsence(await getDb(), perms, id, today());
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function decideAbsenceAction(id: string, approve: boolean): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await decideAbsence(await getDb(), perms, id, approve);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Material zu einer Stunde: Text, Datei (optional), Häkchen „Schüler:innen dürfen es sehen“, „Datei entfernen“. */
export async function saveMaterialAction(absenceId: string, lessonId: string, date: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const f = form.get("file");
  const file = f instanceof File && f.size > 0 ? { name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) } : null;
  let id: string | null;
  try {
    id = await saveMaterial(await getDb(), getStorage(), perms, {
      absenceId,
      lessonId,
      date,
      text: String(form.get("text") ?? ""),
      forStudents: form.get("forStudents") === "on",
      file,
      removeFile: form.get("removeFile") === "on",
    });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(PAGE);
  return { ok: true, values: { saved: id ? "1" : "0" } };
}
