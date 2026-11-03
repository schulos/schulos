"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safeMailConfig } from "@schulos/server/mail";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { decodeCsvBytes } from "@/core/csv";
import { formValues } from "@/core/form-values";
import { moduleActions, moduleOn } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { INVENTORY_ITEM_STATE_LABELS, TICKET_CATEGORIES, TICKET_STATUSES, type InventoryItemState, type TicketCategory, type TicketStatus } from "./labels";
import { adoptInventoryItem, closeInventory, deleteInventory, scanAsset, scanInput, setInventoryItem, startInventory, type ScanResult } from "./inventur";
import { addAssetPhoto, deleteAssetPhoto, moveAsset, setAssetCondition } from "./asset-seite";
import { renewAssetCode } from "./etiketten";
import { cancelLoan, extendLoan, lendAsset, returnLoan } from "./leihe";
import { createCategory, deleteCategory, updateCategory, type CategoryInput } from "./inventar";
import { CSV_FIELDS, MAX_ASSET_CSV_BYTES, executeAssetImport, planAssetImport, type CsvField, type CsvLayout, type ImportPreview } from "./inventar-csv";
import {
  canConfigure,
  cancelInspection,
  createAsset,
  createInspectionType,
  deleteAsset,
  planInspection,
  recordInspection,
  runInspectionReminders,
  setAssetActive,
  updateAsset,
  updateInspectionType,
  type AssetInput,
  type InspectionTypeInput,
} from "./pruefungen";
import { addComment, addPhotos, assignTicket, blockRoomFromTicket, changeStatus, createTicket, endTicketBlock, setResponsibility } from "./service";
import { createMaintenance, deleteMaintenance } from "./wartung";

const { requireUser } = moduleActions("gebaeude");

function fail(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: formValues(form) };
  throw err;
}

async function filesOf(form: FormData, name: string): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const f of form.getAll(name)) if (f instanceof File && f.size > 0) out.push(new Uint8Array(await f.arrayBuffer()));
  return out;
}

export async function createTicketAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const db = await getDb();
  let id: string;
  try {
    const config = safeMailConfig();
    ({ id } = await createTicket(
      db,
      getStorage(),
      perms,
      {
        category: str("category"),
        priority: str("priority") || "normal",
        roomId: str("roomId") || null,
        location: str("location") || null,
        title: str("title"),
        description: str("description"),
        photos: await filesOf(form, "photos"),
        assetId: str("assetId") || null,
      },
      { mail: { config, server: config ? `SchulOS ${(await readSchoolSettings(db)).name}` : undefined } },
    ));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/gebaeude/${id}?gemeldet=1`);
}

export async function changeStatusAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const to = String(form.get("status") ?? "");
  if (!(TICKET_STATUSES as readonly string[]).includes(to)) return { error: "Status wählen" };
  try {
    await changeStatus(await getDb(), perms, id, to as TicketStatus, {
      comment: String(form.get("comment") ?? ""),
      endBlock: form.get("endBlock") === "on",
      todayYmd: toBerlinDate(new Date()),
    });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function commentAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addComment(await getDb(), perms, id, String(form.get("comment") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function assignAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await assignTicket(await getDb(), perms, id, String(form.get("assigneeId") ?? "") || null);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function addPhotosAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await addPhotos(await getDb(), getStorage(), perms, id, await filesOf(form, "photos"));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function blockRoomAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const period = (k: string) => (str(k) ? Number(str(k)) : null);
  try {
    await blockRoomFromTicket(
      await getDb(),
      perms,
      id,
      { startsOn: str("startsOn"), endsOn: str("endsOn") || str("startsOn"), fromPeriod: period("fromPeriod"), toPeriod: period("toPeriod") },
      toBerlinDate(new Date()),
    );
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function endBlockAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await endTicketBlock(await getDb(), perms, id, toBerlinDate(new Date()));
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- Verwaltung: Prüfarten, Zuständigkeiten (P4-15)

const today = () => toBerlinDate(new Date());

function typeInput(form: FormData): InspectionTypeInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    name: str("name"),
    appliesTo: str("appliesTo"),
    categoryId: str("categoryId") || null,
    intervalMonths: Number(str("intervalMonths")),
    warnDays: Number(str("warnDays")),
    source: str("source"),
    responsible: str("responsible"),
    note: str("note") || null,
    active: form.get("active") === "on",
  };
}

/** Prüfart speichern (id) bzw. eigene anlegen (null). */
export async function saveInspectionTypeAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    if (id) await updateInspectionType(await getDb(), perms, id, typeInput(form), today());
    else await createInspectionType(await getDb(), perms, typeInput(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setResponsibilityAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const db = await getDb();
  try {
    for (const c of TICKET_CATEGORIES) {
      if (!form.has(`group-${c}`)) continue;
      await setResponsibility(db, perms, c as TicketCategory, String(form.get(`group-${c}`) ?? "") || null);
    }
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------- Inventar (P4-15, INV-01/INV-02)

function assetInput(form: FormData): AssetInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    name: str("name"),
    categoryId: str("categoryId"),
    roomId: str("roomId") || null,
    buildingId: str("buildingId") || null,
    floorId: str("floorId") || null,
    inventoryNo: str("inventoryNo") || null,
    manufacturer: str("manufacturer") || null,
    model: str("model") || null,
    serial: str("serial") || null,
    condition: str("condition") || null,
    quantity: str("quantity") || null,
    price: str("price") || null,
    supplier: str("supplier") || null,
    financing: str("financing") || null,
    boundUntil: str("boundUntil") || null,
    warrantyUntil: str("warrantyUntil") || null,
    acquiredOn: str("acquiredOn") || null,
    note: str("note") || null,
  };
}

export async function createAssetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    id = await createAsset(await getDb(), perms, assetInput(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  redirect(`/gebaeude/inventar/${id}?angelegt=1`);
}

export async function updateAssetAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await updateAsset(await getDb(), perms, id, assetInput(form), today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Ausmustern (mit Grund) bzw. wieder in Betrieb nehmen. */
export async function setAssetActiveAction(id: string, active: boolean, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setAssetActive(await getDb(), perms, id, active, today(), String(form.get("reason") ?? "") || null);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteAssetAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteAsset(await getDb(), perms, id, getStorage());
  revalidatePath("/", "layout");
  redirect("/gebaeude/inventar?geloescht=1");
}

/** INV-02: neuen Etikett-Code erzeugen – der alte führt danach nirgends mehr hin. */
export async function renewAssetCodeAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await renewAssetCode(await getDb(), perms, id);
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- INV-03: Aktionen der Asset-Seite

/** Zustand per Knopf (`condition` am gedrückten Knopf, leer = offen). */
export async function setAssetConditionAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await setAssetCondition(await getDb(), perms, id, String(form.get("condition") ?? "") || null);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/gebaeude/inventar/${id}`);
  return { ok: true };
}

/** Standort ändern (Umzug in einen Raum). */
export async function moveAssetAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await moveAsset(await getDb(), perms, id, String(form.get("roomId") ?? ""));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/gebaeude/inventar/${id}`);
  return { ok: true };
}

/** Foto hochladen (mobil mit Kamera). */
export async function addAssetPhotoAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("photo");
  const photo = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  try {
    await addAssetPhoto(await getDb(), getStorage(), perms, id, photo);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/gebaeude/inventar/${id}`);
  return { ok: true };
}

export async function deleteAssetPhotoAction(photoId: string): Promise<void> {
  const { perms } = await requireUser();
  const assetId = await deleteAssetPhoto(await getDb(), getStorage(), perms, photoId);
  revalidatePath(`/gebaeude/inventar/${assetId}`);
}

function categoryInput(form: FormData): CategoryInput {
  const str = (k: string) => String(form.get(k) ?? "");
  return {
    name: str("name"),
    prefix: str("prefix"),
    inspectionRequired: form.get("inspectionRequired") === "on",
    responsibleGroupId: str("responsibleGroupId") || null,
    sortOrder: Number(str("sortOrder") || "0"),
    active: form.get("active") === "on",
  };
}

/** Kategorie speichern (id) bzw. eigene anlegen (null) – Recht `gebaeude.configure`. */
export async function saveCategoryAction(id: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    if (id) await updateCategory(await getDb(), perms, id, categoryInput(form));
    else await createCategory(await getDb(), perms, categoryInput(form));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteCategoryAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await deleteCategory(await getDb(), perms, id);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export interface AssetImportState {
  preview?: ImportPreview;
  text?: string;
  error?: string;
  done?: { created: number; updated: number; skipped: number };
}

/** Spaltenzuordnung aus dem Vorschau-Formular (`kopfzeile`, `spalte<i>`); ohne Felder → automatisch erkennen. */
function layoutOf(form: FormData): CsvLayout | undefined {
  if (form.get("zuordnung") !== "1") return undefined;
  const columns: (CsvField | null)[] = [];
  for (let i = 0; i < 100 && form.has(`spalte${i}`); i++) {
    const v = String(form.get(`spalte${i}`));
    columns.push((CSV_FIELDS as readonly string[]).includes(v) ? (v as CsvField) : null);
  }
  return { header: form.get("kopfzeile") === "1", columns };
}

/** INV-06 Schritt 1: Datei lesen und prüfen (Trockenlauf) – nichts wird gespeichert. Erneut mit geänderter Zuordnung: `text`. */
export async function previewAssetImportAction(_prev: AssetImportState, form: FormData): Promise<AssetImportState> {
  const { perms } = await requireUser();
  let text = String(form.get("text") ?? "");
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_ASSET_CSV_BYTES) return { error: "Datei zu groß (höchstens 512 KB)" };
    text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer())).text;
  }
  if (!text) return { error: "Bitte eine CSV-Datei wählen" };
  if (text.length > MAX_ASSET_CSV_BYTES) return { error: "Datei zu groß (höchstens 512 KB)" };
  try {
    const plan = await planAssetImport(await getDb(), perms, text, layoutOf(form));
    return { preview: plan.preview, text };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "Keine Berechtigung, Inventar zu importieren" };
    throw err;
  }
}

/** Schritt 2: serverseitig neu prüfen und nur ohne Fehler übernehmen – ganz oder gar nicht. */
export async function runAssetImportAction(_prev: AssetImportState, form: FormData): Promise<AssetImportState> {
  const { perms } = await requireUser();
  const text = String(form.get("text") ?? "");
  if (!text || text.length > MAX_ASSET_CSV_BYTES) return { error: "Datei fehlt oder ist zu groß – bitte neu wählen" };
  const db = await getDb();
  try {
    const plan = await planAssetImport(db, perms, text, layoutOf(form));
    if (!plan.preview.ok) return { preview: plan.preview, text, error: "Die Datei hat Fehler bzw. nichts zu übernehmen – nichts übernommen" };
    const done = await executeAssetImport(db, perms, plan, today());
    revalidatePath("/", "layout");
    return { done };
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "Keine Berechtigung, Inventar zu importieren" };
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", text };
    throw err;
  }
}

// ---------------------------------------------------------------- Prüfungen (P4-16)

export async function planInspectionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    await planInspection(await getDb(), perms, { typeId: str("typeId"), assetId: str("assetId") || null, roomId: str("roomId") || null, building: str("building") || null, dueOn: str("dueOn") });
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function recordInspectionAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const file = form.get("report");
  try {
    const report = file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null;
    await recordInspection(
      await getDb(),
      getStorage(),
      perms,
      id,
      { doneOn: str("doneOn"), result: str("result"), company: str("company") || null, note: str("note") || null, report },
      { today: today() },
    );
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function cancelInspectionAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await cancelInspection(await getDb(), perms, id);
  revalidatePath("/", "layout");
}

/** Fristen sofort prüfen (wie der nächtliche Lauf) – Recht `gebaeude.configure`. */
export async function runRemindersAction(): Promise<FormState> {
  const { perms } = await requireUser();
  if (!canConfigure(perms)) throw new ForbiddenError("gebaeude.configure");
  const db = await getDb();
  const config = safeMailConfig();
  let r: Awaited<ReturnType<typeof runInspectionReminders>>;
  try {
    r = await runInspectionReminders(db, { mail: { config, server: config ? `SchulOS ${(await readSchoolSettings(db)).name}` : undefined } });
  } catch (err) {
    return { error: `Erinnerung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    values: {
      result:
        r.overdue + r.due === 0
          ? "Keine neuen Erinnerungen fällig."
          : `Erinnert: ${r.overdue} überfällig, ${r.due} bald fällig${r.mailed ? " (Alarm-Mail gesendet)" : r.mailError ? ` – Alarm-Mail fehlgeschlagen: ${r.mailError}` : ""}.`,
    },
  };
}

// ---------------------------------------------------------------- Wartung (P4-17)

export async function createMaintenanceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    const calendar = form.get("calendar") === "on" && (await moduleOn("kalender"));
    const r = await createMaintenance(await getDb(), perms, {
      title: str("title"),
      provider: str("provider") || null,
      start: str("start"),
      end: str("end"),
      building: str("building") || null,
      roomIds: form.getAll("roomIds").map(String),
      note: str("note") || null,
      blockRooms: form.get("blockRooms") === "on",
      calendar,
    });
    revalidatePath("/", "layout");
    return { ok: true, values: { result: r.notified ? `Gespeichert – ${r.notified === 1 ? "1 Lehrkraft" : `${r.notified} Lehrkräfte`} benachrichtigt.` : "Gespeichert." } };
  } catch (err) {
    return fail(err, form);
  }
}

export async function deleteMaintenanceAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteMaintenance(await getDb(), perms, id);
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- Inventur (INV-04)

/** Rückmeldung eines Scans als Text (Kamera, Eingabe, Geräteseite). */
function scanMessage(r: ScanResult): string {
  const label = `${r.inventoryNo ? `${r.inventoryNo} ` : ""}${r.name}`;
  if (r.already) return `${label}: schon erfasst (${INVENTORY_ITEM_STATE_LABELS[r.state]}).`;
  if (r.state === "falscher_raum") return `${label}: falscher Raum – gehört laut Inventar ${r.homeRoomId ? `in Raum ${r.homeRoomId}` : "keinem Raum an"}.`;
  return `${label}: gefunden.`;
}

export async function startInventoryAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  let id: string;
  try {
    ({ id } = await startInventory(await getDb(), perms, String(form.get("roomId") ?? "")));
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/gebaeude/inventur");
  redirect(`/gebaeude/inventur/${encodeURIComponent(id)}`);
}

/** Scan in der App bzw. Eingabe (Kurz-URL, Code, Inventarnummer) – auch direkt aus dem Kamera-Scan aufgerufen. */
export async function scanInventoryAction(inventoryId: string, raw: string): Promise<{ ok: boolean; message: string; state?: InventoryItemState }> {
  const { perms } = await requireUser();
  try {
    const r = await scanInput(await getDb(), perms, String(inventoryId), String(raw));
    revalidatePath(`/gebaeude/inventur/${inventoryId}`);
    return { ok: true, message: scanMessage(r), state: r.state };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, message: Object.values(err.fieldErrors)[0] ?? "Eingabe prüfen" };
    throw err;
  }
}

export async function scanInventoryFormAction(inventoryId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const r = await scanInventoryAction(inventoryId, String(form.get("code") ?? ""));
  return r.ok ? { ok: true, message: r.message } : { error: r.message, fieldErrors: { code: r.message } };
}

/** Geräteseite (Ziel des Etiketts): „gefunden“ in einer laufenden Inventur. */
export async function scanAssetAction(inventoryId: string, assetId: string): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const r = await scanAsset(await getDb(), perms, inventoryId, assetId, "etikett");
    revalidatePath(`/gebaeude/inventar/${assetId}`);
    return { ok: true, message: scanMessage(r) };
  } catch (err) {
    if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht erfasst" };
    throw err;
  }
}

/** Posten per Knopf: gefunden (Sammelposten mit Menge), fehlt, zurück auf offen. */
export async function setInventoryItemAction(itemId: string, state: string, form: FormData): Promise<void> {
  const { perms } = await requireUser();
  let inventoryId: string;
  try {
    const counted = form.get("counted");
    inventoryId = await setInventoryItem(await getDb(), perms, itemId, state, counted === null ? null : String(counted));
  } catch (err) {
    if (err instanceof ValidationError) return; // veraltete Ansicht (abgeschlossen, gelöscht) – die Seite lädt neu
    throw err;
  }
  revalidatePath(`/gebaeude/inventur/${inventoryId}`);
}

/** Gerät aus einem anderen Raum in den Inventurraum übernehmen. */
export async function adoptInventoryItemAction(itemId: string): Promise<void> {
  const { perms } = await requireUser();
  let inventoryId: string;
  try {
    inventoryId = await adoptInventoryItem(await getDb(), perms, itemId);
  } catch (err) {
    if (err instanceof ValidationError) return;
    throw err;
  }
  revalidatePath(`/gebaeude/inventur/${inventoryId}`);
}

export async function closeInventoryAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await closeInventory(await getDb(), perms, id).catch((err: unknown) => {
    if (!(err instanceof ValidationError)) throw err;
  });
  revalidatePath("/gebaeude/inventur");
  revalidatePath(`/gebaeude/inventur/${id}`);
}

export async function deleteInventoryAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await deleteInventory(await getDb(), perms, id).catch((err: unknown) => {
    if (!(err instanceof ValidationError)) throw err;
  });
  revalidatePath("/gebaeude/inventur");
  redirect("/gebaeude/inventur?geloescht=1");
}

// ---------------------------------------------------------------- Ausleihe (INV-05)

/** Gerät an die gewählte Person verleihen; danach zurück zur Geräteseite (ohne Suchparameter). */
export async function lendAssetAction(assetId: string, userId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    await lendAsset(await getDb(), perms, assetId, { userId, dueOn: String(form.get("dueOn") ?? ""), accessories: String(form.get("accessories") ?? "") }, today());
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath(`/gebaeude/inventar/${assetId}`);
  revalidatePath("/gebaeude/leihen");
  redirect(`/gebaeude/inventar/${encodeURIComponent(assetId)}?verliehen=1#leihe`);
}

/** Rückgabedatum ändern (verlängern bzw. verkürzen). */
export async function extendLoanAction(loanId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const assetId = await extendLoan(await getDb(), perms, loanId, String(form.get("dueOn") ?? ""), today());
    revalidatePath(`/gebaeude/inventar/${assetId}`);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/gebaeude/leihen");
  return { ok: true };
}

/** Rückgabe buchen (optional mit Befund). */
export async function returnLoanAction(loanId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const assetId = await returnLoan(await getDb(), perms, loanId, String(form.get("note") ?? ""));
    revalidatePath(`/gebaeude/inventar/${assetId}`);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/gebaeude/leihen");
  return { ok: true };
}

/** Versehentlich angelegte Ausleihe stornieren. */
export async function cancelLoanAction(loanId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  try {
    const assetId = await cancelLoan(await getDb(), perms, loanId);
    revalidatePath(`/gebaeude/inventar/${assetId}`);
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/gebaeude/leihen");
  return { ok: true };
}
