"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { ROLES, type Role } from "@/core/roles";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { addAttachment, deleteAttachment } from "./attachments";
import type { HilfePageStatus } from "./schema";
import { createPage, createSection, deletePage, deleteSection, markReviewed, movePage, moveSection, renameSection, restoreRevision, updatePage, type PageInput } from "./service";
import { installStarterPages } from "./starter";

// Rechte prüft der Service (Pflegende bzw. Ansprechperson der Seite); moduleActions sperrt das ausgeschaltete Modul.
const { requireUser } = moduleActions("hilfe");

function readPage(form: FormData): PageInput {
  const contact = String(form.get("contactId") ?? "");
  return {
    sectionId: String(form.get("sectionId") ?? ""),
    title: String(form.get("title") ?? ""),
    body: String(form.get("body") ?? ""),
    status: (form.get("status") === "veroeffentlicht" ? "veroeffentlicht" : "entwurf") satisfies HilfePageStatus,
    contactId: contact || null,
    targetRoles: form.getAll("targetRole").map(String).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
    targetGroupIds: form.getAll("targetGroup").map(String).filter(Boolean),
  };
}

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: "Bitte die markierten Felder prüfen.", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

export async function createPageAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let slug: string;
  try {
    slug = await createPage(await getDb(), perms, readPage(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/hilfe", "layout");
  redirect(`/hilfe/${slug}`);
}

export async function updatePageAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let slug: string;
  try {
    slug = await updatePage(await getDb(), perms, id, readPage(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/hilfe", "layout");
  redirect(`/hilfe/${slug}`);
}

export async function markReviewedAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await markReviewed(await getDb(), perms, id);
  revalidatePath("/", "layout");
}

export async function movePageAction(id: string, dir: -1 | 1): Promise<void> {
  const { perms } = await requireUser();
  await movePage(await getDb(), perms, id, dir === -1 ? -1 : 1);
  revalidatePath("/hilfe", "layout");
}

export async function deletePageAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deletePage(await getDb(), perms, id, getStorage());
  revalidatePath("/hilfe", "layout");
  redirect("/hilfe");
}

export async function createSectionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await createSection(await getDb(), perms, String(form.get("title") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/hilfe", "layout");
  return { ok: true, message: "Bereich angelegt." };
}

export async function renameSectionAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await renameSection(await getDb(), perms, id, String(form.get("title") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/hilfe", "layout");
  return { ok: true, message: "Gespeichert." };
}

export async function moveSectionAction(id: string, dir: -1 | 1): Promise<void> {
  const { perms } = await requireUser();
  await moveSection(await getDb(), perms, id, dir === -1 ? -1 : 1);
  revalidatePath("/hilfe", "layout");
}

export async function deleteSectionAction(id: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteSection(await getDb(), perms, id);
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] };
    throw err;
  }
  revalidatePath("/hilfe", "layout");
  return { ok: true, message: "Bereich gelöscht." };
}

export async function addAttachmentAction(pageId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("file");
  const data = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  try {
    await addAttachment(await getDb(), getStorage(), perms, pageId, { name: file instanceof File ? file.name : "", data });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/hilfe", "layout");
  return { ok: true, message: "Anhang hochgeladen." };
}

export async function deleteAttachmentAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteAttachment(await getDb(), getStorage(), perms, id);
  revalidatePath("/hilfe", "layout");
}

export async function restoreRevisionAction(revisionId: string): Promise<void> {
  const { perms } = await requireUser();
  const slug = await restoreRevision(await getDb(), perms, revisionId);
  revalidatePath("/hilfe", "layout");
  redirect(`/hilfe/${slug}`);
}

export async function installStarterPagesAction(): Promise<FormState> {
  const { perms } = await requireUser();
  const created = await installStarterPages(await getDb(), perms);
  revalidatePath("/", "layout");
  return { ok: true, message: created.length ? `${created.length} Starter-Seiten angelegt.` : "Alle Starter-Seiten sind schon vorhanden." };
}
