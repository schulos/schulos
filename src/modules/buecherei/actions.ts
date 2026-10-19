"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { classMemberIds, ensureCards, replaceCard } from "./cards";
import { markLabelsPrinted, markQueuePrinted, requeueLabel } from "./etiketten";
import { checkin, renewLoan, renewOwnLoan, resolveFinding, scanAtDesk } from "./loans";
import { cancelReservation, reserve } from "./reservations";
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

// ---------------------------------------------------------------- Theke (BU-02)

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const fmtDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));
const overdueText = (days: number) => (days > 0 ? ` – war ${days === 1 ? "1 Tag" : `${days} Tage`} überfällig` : "");

/** Ein Scan an der Theke (Hand-Scanner tippt den Code und Enter): Rückgabe oder Ausleihe an die gewählte Person. */
export async function scanAction(personId: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let r: Awaited<ReturnType<typeof scanAtDesk>>;
  try {
    r = await scanAtDesk(await getDb(), perms, String(form.get("code") ?? ""), personId, today());
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingabe prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  // BU-07: Ausweis gescannt → diese Person wählen
  if (r.kind === "person") redirect(`/buecherei/theke?person=${encodeURIComponent(r.userId)}`);
  revalidatePath("/buecherei", "layout");
  return {
    ok: true,
    values: {
      result: r.kind === "loan" ? `Ausgeliehen: ${r.title} (${r.barcode}), fällig am ${fmtDay(r.dueOn)}` : `Zurückgebucht: ${r.title} (${r.barcode})${overdueText(r.overdueDays)}`,
    },
  };
}

/** Rückgabe mit Befund (Schaden, unvollständig): die Ausleihe bleibt bis zur Erledigung durch die Verwaltung. */
export async function returnWithFindingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const finding = String(form.get("finding") ?? "").trim();
  if (finding.length < 2) return { error: "Befund angeben", fieldErrors: { finding: "Befund angeben, z. B. „Wasserschaden“ (keine Namen)" }, values: formValues(form) };
  try {
    const r = await checkin(await getDb(), perms, String(form.get("code") ?? ""), today(), finding);
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: `Zurückgebucht mit Befund: ${r.title} (${r.barcode})${overdueText(r.overdueDays)}` } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function renewLoanAction(loanId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const r = await renewLoan(await getDb(), perms, loanId, today());
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: `Verlängert bis ${fmtDay(r.dueOn)}` } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function resolveFindingAction(loanId: string): Promise<void> {
  const { perms } = await requireUser();
  await resolveFinding(await getDb(), perms, loanId, today());
  revalidatePath("/buecherei", "layout");
}

// ---------------------------------------------------------------- Katalog, Vormerkung, Meine Ausleihen (BU-03)

/** Titel vormerken (nur wenn alle Exemplare ausgeliehen sind). */
export async function reserveAction(titleId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const r = await reserve(await getDb(), perms, titleId);
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: `Vorgemerkt – du bist ${r.position === 1 ? "als Nächste:r dran" : `auf Platz ${r.position}`}. Du bekommst Bescheid, sobald ein Exemplar bereitliegt.` } };
  } catch (err) {
    return fail(err, form);
  }
}

/** Eigene Vormerkung löschen. */
export async function cancelReservationAction(reservationId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await cancelReservation(await getDb(), perms, reservationId, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true, values: { result: "Vormerkung gelöscht" } };
}

/** Eigene Ausleihe verlängern („Meine Ausleihen“). */
export async function renewOwnLoanAction(loanId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const r = await renewOwnLoan(await getDb(), perms, loanId, today());
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: `Verlängert bis ${fmtDay(r.dueOn)}` } };
  } catch (err) {
    return fail(err, form);
  }
}

// ---------------------------------------------------------------- Ausweise (BU-07)

/** Fehlende Codes einer Klasse anlegen, dann zur Druckansicht. */
export async function printClassCardsAction(groupId: string): Promise<void> {
  const { perms } = await requireUser();
  const db = await getDb();
  await ensureCards(db, perms, await classMemberIds(db, perms, groupId));
  revalidatePath("/buecherei", "layout");
  redirect(`/druck/buecherei-ausweise?klasse=${encodeURIComponent(groupId)}`);
}

/** Ausweis einer Person drucken (Code anlegen, falls noch keiner da ist). */
export async function printPersonCardAction(userId: string): Promise<void> {
  const { perms } = await requireUser();
  await ensureCards(await getDb(), perms, [userId]);
  redirect(`/druck/buecherei-ausweise?person=${encodeURIComponent(userId)}`);
}

/** Ausweis verloren: neuer Code (der alte gilt sofort nicht mehr), dann drucken. */
export async function replaceCardAction(userId: string): Promise<void> {
  const { perms } = await requireUser();
  await replaceCard(await getDb(), perms, userId);
  redirect(`/druck/buecherei-ausweise?person=${encodeURIComponent(userId)}`);
}

// ---------------------------------------------------------------- Etiketten (BU-05)

/** Aus der Druckansicht: genau die gedruckten Exemplare als gedruckt markieren (aus der Warteschlange nehmen). */
export async function markLabelsPrintedAction(form: FormData): Promise<void> {
  const { perms } = await requireUser();
  const ids = form.getAll("copyId").map(String);
  const n = await markLabelsPrinted(await getDb(), perms, ids, new Date());
  revalidatePath("/buecherei", "layout");
  redirect(`/buecherei/etiketten?gedruckt=${n}`);
}

/** Ganze Warteschlange als gedruckt markieren (Altbestand mit vorhandenen Etiketten). */
export async function markQueuePrintedAction(): Promise<void> {
  const { perms } = await requireUser();
  const n = await markQueuePrinted(await getDb(), perms, new Date());
  revalidatePath("/buecherei", "layout");
  redirect(`/buecherei/etiketten?gedruckt=${n}`);
}

/** Exemplar wieder in die Druckwarteschlange (Etikett beschädigt oder verloren). */
export async function requeueLabelAction(copyId: string): Promise<void> {
  const { perms } = await requireUser();
  await requeueLabel(await getDb(), perms, copyId);
  revalidatePath("/buecherei", "layout");
}
