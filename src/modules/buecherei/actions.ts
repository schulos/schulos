"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/core/db/client";
import { formValues } from "@/core/form-values";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { resolveIssueFinding, scanIssue } from "./ausgabe";
import { classMemberIds, ensureCards, replaceCard } from "./cards";
import { createCompensation, setCompensationStatus, updateCompensation } from "./ersatz";
import { markLabelsPrinted, markQueuePrinted, requeueLabel } from "./etiketten";
import { lookupIsbn } from "./isbn";
import {
  addMaterialCopies,
  createMaterial,
  deleteMaterial,
  restoreMaterialCopy,
  saveBooklist,
  setMaterialArchived,
  updateMaterial,
  updateMaterialCopy,
  withdrawMaterialCopy,
  type MaterialInput,
} from "./lernmittel";
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

// ---------------------------------------------------------------- ISBN-Abfrage (BU-06)

/**
 * Titelangaben zu einer ISBN nachschlagen (nur wenn eingeschaltet): Ergebnis als Vorschlag in `values` – angelegt wird erst
 * über das Formular, nach Prüfung durch das Team. Bei einer Dublette geht nichts nach außen.
 */
export async function lookupIsbnAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const isbn = String(form.get("isbn") ?? "");
  try {
    const r = await lookupIsbn(await getDb(), perms, isbn);
    if (r.kind === "found") {
      const s = r.suggestion;
      return {
        ok: true,
        values: {
          kind: "found",
          source: r.source,
          isbn: s.isbn,
          title: s.title,
          author: s.author ?? "",
          publisher: s.publisher ?? "",
          year: s.year ? String(s.year) : "",
          result: `Vorschlag aus: ${r.source}${r.cached ? " (zwischengespeichert)" : ""} – bitte prüfen und ergänzen`,
        },
      };
    }
    if (r.kind === "duplicate") return { ok: true, values: { kind: "duplicate", titleId: r.titleId, title: r.title, result: `Diese ISBN gehört schon zu „${r.title}“` } };
    if (r.kind === "none") return { ok: true, values: { kind: "none", isbn, result: `Nichts gefunden (gefragt: ${r.asked.join(", ")}) – bitte von Hand anlegen` } };
    return { ok: true, values: { kind: "unreachable", isbn, result: "Bibliothekskataloge nicht erreichbar (kein Internetzugang oder Zeitüberschreitung) – bitte von Hand anlegen" } };
  } catch (err) {
    return fail(err, form);
  }
}

// ---------------------------------------------------------------- Stufe 2: Lernmittel (BU-10)

function materialInput(form: FormData): MaterialInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    title: str("title"),
    author: str("author"),
    isbn: str("isbn"),
    publisher: str("publisher"),
    subjectId: str("subjectId"),
    grades: form.getAll("grades").map(String),
    course: str("course"),
    provision: str("provision"),
    price: str("price"),
    note: str("note"),
  };
}

export async function createMaterialAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    ({ id } = await createMaterial(await getDb(), perms, materialInput(form), {
      count: String(form.get("count") ?? ""),
      acquiredYear: String(form.get("acquiredYear") ?? ""),
    }));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  redirect(`/buecherei/lernmittel/${id}`);
}

export async function updateMaterialAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateMaterial(await getDb(), perms, id, materialInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function archiveMaterialAction(id: string, archived: boolean, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setMaterialArchived(await getDb(), perms, id, archived, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true, values: { result: archived ? "Archiviert – steht nicht mehr auf Bücherlisten." : "Wieder aktiv." } };
}

export async function deleteMaterialAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteMaterial(await getDb(), perms, id);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  redirect("/buecherei/lernmittel");
}

export async function addMaterialCopiesAction(materialId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    const nrs = await addMaterialCopies(await getDb(), perms, materialId, { count: str("count"), condition: str("condition"), acquiredYear: str("acquiredYear") });
    revalidatePath("/buecherei", "layout");
    return { ok: true, values: { result: nrs.length === 1 ? `Exemplar ${nrs[0]} angelegt` : `${nrs.length} Exemplare angelegt (${nrs[0]} bis ${nrs.at(-1)})` } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function updateMaterialCopyAction(copyId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    await updateMaterialCopy(await getDb(), perms, copyId, { condition: str("condition"), conditionNote: str("conditionNote"), acquiredYear: str("acquiredYear") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function withdrawMaterialCopyAction(copyId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await withdrawMaterialCopy(await getDb(), perms, copyId, String(form.get("reason") ?? ""), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true };
}

export async function restoreMaterialCopyAction(copyId: string): Promise<void> {
  const { perms } = await requireUser();
  await restoreMaterialCopy(await getDb(), perms, copyId);
  revalidatePath("/buecherei", "layout");
}

export async function saveBooklistAction(grade: number, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await saveBooklist(await getDb(), perms, grade, { text: String(form.get("text") ?? ""), published: form.get("published") === "on" });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  revalidatePath("/druck/buecherliste");
  return { ok: true, values: { result: "Gespeichert." } };
}

// ---------------------------------------------------------------- Stufe 2: Schulbuchausgabe (BU-11)

const conditionText = (c: string | null) => (c ? `, Zustand jetzt „${c}“` : "");

/**
 * Ein Scan an der Schulbuchausgabe: Ausweis → Person wählen (bleibt in der Klasse), Schulbuch ausgegeben → Rücknahme mit Zustand
 * bzw. Befund aus dem Formular, sonst Ausgabe an die gewählte Person.
 */
export async function scanIssueAction(personId: string | null, groupId: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  let r: Awaited<ReturnType<typeof scanIssue>>;
  try {
    r = await scanIssue(await getDb(), perms, str("code"), personId, today(), { condition: str("condition"), conditionNote: str("conditionNote"), finding: str("finding") });
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingabe prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  if (r.kind === "person") redirect(`/buecherei/ausgabe?${new URLSearchParams({ ...(groupId ? { gruppe: groupId } : {}), person: r.userId })}`);
  revalidatePath("/buecherei", "layout");
  return {
    ok: true,
    values: {
      result:
        r.kind === "issue"
          ? `Ausgegeben: ${r.title} (${r.inventoryNumber}), zurück bis ${fmtDay(r.dueOn)}`
          : `${r.finding ? "Zurückgenommen mit Befund" : "Zurückgenommen"}: ${r.title} (${r.inventoryNumber})${conditionText(r.condition)}${overdueText(r.overdueDays)}`,
    },
  };
}

// ---------------------------------------------------------------- Stufe 2: Ersatzforderungen (BU-12)

/** Ersatzforderung anlegen – `kind` „ausleihe“ (Befund Stufe 1) oder „schulbuch“/„verlust“ (Ausgabe). */
export async function createCompensationAction(kind: "ausleihe" | "schulbuch" | "verlust", sourceId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await createCompensation(await getDb(), perms, kind === "ausleihe" ? { loanId: sourceId } : { issueId: sourceId }, { amount: String(form.get("amount") ?? ""), reason: String(form.get("reason") ?? "") }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true, values: { result: "Ersatzforderung angelegt." } };
}

export async function updateCompensationAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateCompensation(await getDb(), perms, id, { amount: String(form.get("amount") ?? ""), reason: String(form.get("reason") ?? "") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/buecherei", "layout");
  return { ok: true, values: { result: "Gespeichert." } };
}

export async function compensationStatusAction(id: string, status: string): Promise<void> {
  const { perms } = await requireUser();
  await setCompensationStatus(await getDb(), perms, id, status, today());
  revalidatePath("/buecherei", "layout");
}

export async function resolveIssueFindingAction(issueId: string): Promise<void> {
  const { perms } = await requireUser();
  await resolveIssueFinding(await getDb(), perms, issueId, today());
  revalidatePath("/buecherei", "layout");
}
