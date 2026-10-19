"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { MAX_TITLE_CSV_BYTES, addCopies, createTitle, deleteTitle, importTitles, restoreCopy, updateCopy, updateTitle, withdrawCopy, type TitleInput } from "./service";

const { requireUser } = moduleActions("buecherei");

const today = () => toBerlinDate(new Date());

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

function titleInput(form: FormData): TitleInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    title: str("title"),
    author: str("author"),
    isbn: str("isbn"),
    publisher: str("publisher"),
    year: str("year"),
    keywords: str("keywords"),
    ageFrom: str("ageFrom"),
    mediaType: str("mediaType"),
    note: str("note"),
  };
}

export async function createTitleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    ({ id } = await createTitle(await getDb(), perms, titleInput(form), {
      count: String(form.get("count") ?? ""),
      signature: String(form.get("signature") ?? ""),
      location: String(form.get("location") ?? ""),
    }));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  redirect(`/buecherei/bestand/${id}`);
}

export async function updateTitleAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateTitle(await getDb(), perms, id, titleInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function deleteTitleAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteTitle(await getDb(), perms, id);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  redirect("/buecherei/bestand");
}

export async function addCopiesAction(titleId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    const barcodes = await addCopies(await getDb(), perms, titleId, { count: str("count"), signature: str("signature"), location: str("location"), condition: str("condition") });
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: barcodes.length === 1 ? `Exemplar ${barcodes[0]} angelegt` : `${barcodes.length} Exemplare angelegt (${barcodes[0]} bis ${barcodes.at(-1)})` } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function updateCopyAction(copyId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    await updateCopy(await getDb(), perms, copyId, { signature: str("signature"), location: str("location"), condition: str("condition") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function withdrawCopyAction(copyId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await withdrawCopy(await getDb(), perms, copyId, String(form.get("reason") ?? ""), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function restoreCopyAction(copyId: string): Promise<void> {
  const { perms } = await requireUser();
  await restoreCopy(await getDb(), perms, copyId);
  revalidatePath("/buecherei", "layout");
}

export async function importTitlesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine CSV-Datei wählen", fieldErrors: { file: "Bitte eine CSV-Datei wählen" } };
  if (file.size > MAX_TITLE_CSV_BYTES) return { error: "Datei zu groß (höchstens 1 MB)", fieldErrors: { file: "Datei zu groß (höchstens 1 MB)" } };
  const dryRun = form.get("dryRun") === "on";
  try {
    const r = await importTitles(await getDb(), perms, await file.text(), { dryRun });
    if (!dryRun) revalidatePath("/buecherei", "layout");
    const text = `${r.titles} neue Titel, ${r.existing} Zeilen zu vorhandenen Titeln, ${r.copies} Exemplare`;
    return { ok: true, values: { result: dryRun ? `Vorschau – nichts übernommen: ${text}` : `Importiert: ${text}` } };
  } catch (err) {
    return fail(err, form);
  }
}
