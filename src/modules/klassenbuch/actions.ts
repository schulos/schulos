"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { saveEntry, type AbsenceInput } from "./service";

const { requireUser } = moduleActions("klassenbuch");

export async function saveEntryAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const absences: AbsenceInput[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("status-") || value === "present") continue;
    const studentId = key.slice(7);
    const minutes = Number(str(`late-${studentId}`));
    absences.push({ studentId, kind: value === "late" ? "late" : "absent", minutesLate: value === "late" && minutes > 0 ? minutes : null });
  }
  const date = str("date");
  try {
    await saveEntry(await getDb(), perms, { lessonId: str("lessonId"), date, topic: str("topic"), homework: str("homework"), homeworkDue: str("homeworkDue"), absences, alsoCoupled: form.get("alsoCoupled") === "on" }, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) {
      const values = Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/klassenbuch?datum=${date}`);
}
