"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createExam, deleteExam, examSeatWarnings, type ExamInput } from "./service";

const { requireUser } = moduleActions("klausurplan");

export async function createExamAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const input: ExamInput = {
    groupId: str("groupId"),
    subjectId: str("subjectId"),
    kind: (str("kind") || "klassenarbeit") as ExamInput["kind"],
    title: str("title"),
    date: str("date"),
    periodFrom: Number(str("periodFrom")),
    periodTo: Number(str("periodTo")),
    roomId: str("roomId") || null,
    override: form.get("override") === "on",
  };
  let warning: string | undefined;
  try {
    const db = await getDb();
    const id = await createExam(db, perms, input, toBerlinDate(new Date()));
    // RS-09: Überbelegung laut Raumlayout nur als Hinweis
    warning = (await examSeatWarnings(db, perms, [{ id, groupId: input.groupId, roomId: input.roomId }])).get(id);
  } catch (err) {
    if (err instanceof ValidationError) {
      const values = Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true, message: warning };
}

export async function deleteExamAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteExam(await getDb(), perms, id);
  revalidatePath("/", "layout");
}
