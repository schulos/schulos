"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createBoard } from "./service";

const { requireUser } = moduleActions("tafeln");

// Rechte hängen an der Mitgliedschaft in der Gruppe (Gruppenordner) – geprüft im Service.

export async function createBoardAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createBoard(await getDb(), getStorage(), perms, { title: String(form.get("title") ?? ""), groupId: String(form.get("groupId") ?? "") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Bitte die Eingaben prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
    if (err instanceof ForbiddenError) return { error: "In dieser Gruppe gibt es keinen Gruppenordner für dich.", values: formValues(form) };
    throw err;
  }
  revalidatePath("/tafeln");
  revalidatePath("/dateien");
  redirect(`/tafeln/${id}`);
}
