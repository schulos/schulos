"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safeMailConfig } from "@schulos/server/mail";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { formValues } from "@/core/form-values";
import { moduleActions, moduleOn } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { TICKET_CATEGORIES, TICKET_STATUSES, type TicketCategory, type TicketStatus } from "./labels";
import {
  MAX_ASSET_CSV_BYTES,
  canConfigure,
  cancelInspection,
  createAsset,
  createInspectionType,
  importAssets,
  planInspection,
  recordInspection,
  runInspectionReminders,
  setAssetActive,
  updateInspectionType,
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
    assetKind: str("assetKind") || null,
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

// ---------------------------------------------------------------- Anlagen (P4-15)

export async function createAssetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    await createAsset(
      await getDb(),
      perms,
      {
        name: str("name"),
        kind: str("kind"),
        roomId: str("roomId") || null,
        building: str("building") || null,
        inventoryNo: str("inventoryNo") || null,
        manufacturer: str("manufacturer") || null,
        serial: str("serial") || null,
        acquiredOn: str("acquiredOn") || null,
        note: str("note") || null,
      },
      today(),
    );
  } catch (err) {
    return fail(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setAssetActiveAction(id: string, active: boolean): Promise<void> {
  const { perms } = await requireUser();
  await setAssetActive(await getDb(), perms, id, active, today());
  revalidatePath("/", "layout");
}

export async function importAssetsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine CSV-Datei wählen", fieldErrors: { file: "Bitte eine CSV-Datei wählen" } };
  if (file.size > MAX_ASSET_CSV_BYTES) return { error: "Datei zu groß (höchstens 512 KB)", fieldErrors: { file: "Datei zu groß (höchstens 512 KB)" } };
  try {
    const r = await importAssets(await getDb(), perms, await file.text(), today());
    revalidatePath("/", "layout");
    return { ok: true, values: { result: `${r.created} angelegt, ${r.updated} aktualisiert` } };
  } catch (err) {
    return fail(err, form);
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
