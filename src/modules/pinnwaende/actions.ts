"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { BOARD_MODES, CARD_KINDS, type BoardMode, type CardKind } from "./schema";
import { addBoardMember, addCard, addColumn, approveCard, createBoard, deleteBoard, deleteCard, deleteColumn, moveCard, removeBoardMember, renameColumn, updateBoard } from "./service";

const { requireUser } = moduleActions("pinnwaende");

// Rechte hängen an der Rolle auf der Pinnwand (Leitung/Mitglied) – geprüft im Service.

function fail(err: unknown, form?: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Bitte die Eingaben prüfen.", fieldErrors: err.fieldErrors, ...(form ? { values: formValues(form) } : {}) };
  throw err;
}

const mode = (v: FormDataEntryValue | null) => ((BOARD_MODES as readonly string[]).includes(String(v)) ? (String(v) as BoardMode) : ("" as BoardMode));

export async function createBoardAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    const group = String(form.get("groupId") ?? "");
    id = await createBoard(await getDb(), perms, { title: String(form.get("title") ?? ""), mode: mode(form.get("mode")), groupId: group || null });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/pinnwaende");
  redirect(`/pinnwaende/${id}`);
}

export async function updateBoardAction(boardId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateBoard(await getDb(), perms, boardId, { title: String(form.get("title") ?? ""), mode: mode(form.get("mode")), onMonitor: form.get("onMonitor") === "on" });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return { ok: true };
}

export async function deleteBoardAction(boardId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteBoard(await getDb(), perms, boardId);
  revalidatePath("/pinnwaende");
  redirect("/pinnwaende");
}

export async function addColumnAction(boardId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addColumn(await getDb(), perms, boardId, String(form.get("column") ?? ""));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return { ok: true };
}

export async function renameColumnAction(boardId: string, columnId: string, title: string): Promise<string | null> {
  const { perms } = await requireUser();
  try {
    await renameColumn(await getDb(), perms, columnId, title);
  } catch (err) {
    return fail(err).error ?? null;
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return null;
}

export async function deleteColumnAction(boardId: string, columnId: string): Promise<string | null> {
  const { perms } = await requireUser();
  try {
    await deleteColumn(await getDb(), perms, columnId);
  } catch (err) {
    return fail(err).error ?? null;
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return null;
}

export async function addCardAction(boardId: string, columnId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const kind = String(form.get("kind"));
  try {
    await addCard(await getDb(), perms, boardId, {
      columnId,
      kind: (CARD_KINDS as readonly string[]).includes(kind) ? (kind as CardKind) : ("" as CardKind),
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      url: String(form.get("url") ?? ""),
      fileId: String(form.get("fileId") ?? ""),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return { ok: true };
}

export async function approveCardAction(boardId: string, cardId: string): Promise<void> {
  const { perms } = await requireUser();
  await approveCard(await getDb(), perms, cardId);
  revalidatePath(`/pinnwaende/${boardId}`);
}

export async function deleteCardAction(boardId: string, cardId: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteCard(await getDb(), perms, cardId);
  revalidatePath(`/pinnwaende/${boardId}`);
}

export async function addMemberAction(boardId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addBoardMember(await getDb(), perms, boardId, String(form.get("username") ?? ""));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/pinnwaende/${boardId}`);
  return { ok: true };
}

export async function removeMemberAction(boardId: string, userId: string): Promise<void> {
  const { perms } = await requireUser();
  await removeBoardMember(await getDb(), perms, boardId, userId);
  revalidatePath(`/pinnwaende/${boardId}`);
}

/** P3-09: Karte verschieben (Ziehen oder Tastatur). */
export async function moveCardAction(boardId: string, cardId: string, columnId: string, index: number): Promise<void> {
  const { perms } = await requireUser();
  await moveCard(await getDb(), perms, cardId, columnId, index);
  revalidatePath(`/pinnwaende/${boardId}`);
}
