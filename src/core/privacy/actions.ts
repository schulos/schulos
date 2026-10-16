"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { users } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { PRIVACY_TEXT_FIELDS, savePrivacyTexts, type PrivacyTextKey } from "./hinweise";
import { reactivateAccount, requestErasure, setAccountLeft } from "./konto";
import { createHold, endHold, runDeletion } from "./loeschlauf";

const PAGE = "/verwaltung/datenschutz/loeschlauf";

export async function runDeletionAction(form: FormData): Promise<void> {
  const { user } = await requirePermission("verwaltung.privacy");
  if (form.get("confirm") !== "1") redirect(`${PAGE}?fehler=${encodeURIComponent("Bitte bestätigen, dass die Vorschau geprüft wurde")}`);
  const res = await runDeletion(await getDb(), user.id, toBerlinDate(new Date()), { storage: getStorage() });
  revalidatePath("/", "layout");
  redirect(`${PAGE}?geloescht=${res.total}`);
}

export async function createHoldAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.privacy");
  const db = await getDb();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    let userId: string | null = null;
    if (str("username")) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, str("username").toLowerCase()));
      if (!u) throw new ValidationError({ username: "Benutzername nicht gefunden" });
      userId = u.id;
    }
    await createHold(db, user.id, { userId, groupId: str("groupId") || null, reason: str("reason"), until: str("until") }, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError)
      return {
        error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen",
        fieldErrors: err.fieldErrors,
        values: Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])),
      };
    throw err;
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function endHoldAction(id: string): Promise<void> {
  const { user } = await requirePermission("verwaltung.privacy");
  await endHold(await getDb(), user.id, id);
  revalidatePath(PAGE);
  redirect(PAGE);
}

// ---------------------------------------------------------------- Konto-Lebenszyklus

function toState(err: unknown): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
  throw err;
}

export async function setAccountLeftAction(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await setAccountLeft(await getDb(), user.id, id, String(form.get("leftOn") ?? ""));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/verwaltung/benutzer", "layout");
  return { ok: true };
}

export async function reactivateAccountAction(id: string): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.users");
  try {
    await reactivateAccount(await getDb(), user.id, id);
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/verwaltung/benutzer", "layout");
  return { ok: true };
}

/** Löschung auf Antrag (Art. 17) – nur mit Bestätigung; danach zurück zur Benutzerliste bzw. zum gesperrten Konto. */
export async function requestErasureAction(id: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("verwaltung.privacy");
  const page = `/verwaltung/benutzer/${encodeURIComponent(id)}/loeschen`;
  if (form.get("confirm") !== "1") redirect(`${page}?fehler=${encodeURIComponent("Bitte bestätigen, dass der Antrag geprüft wurde")}`);
  let res: Awaited<ReturnType<typeof requestErasure>>;
  try {
    res = await requestErasure(await getDb(), user.id, id, toBerlinDate(new Date()), { storage: getStorage() });
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${page}?fehler=${encodeURIComponent(Object.values(err.fieldErrors)[0] ?? "Nicht möglich")}`);
    throw err;
  }
  revalidatePath("/verwaltung", "layout");
  redirect(res.deleted ? "/verwaltung/benutzer?geloescht=1" : `${page}?vorgemerkt=1`);
}

// ---------------------------------------------------------------- Datenschutzhinweise / VVT

export async function savePrivacyTextsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission("verwaltung.privacy");
  const input = Object.fromEntries((Object.keys(PRIVACY_TEXT_FIELDS) as PrivacyTextKey[]).map((k) => [k, String(form.get(k) ?? "")]));
  try {
    await savePrivacyTexts(await getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ValidationError)
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: input };
    throw err;
  }
  revalidatePath("/datenschutzhinweise");
  revalidatePath("/druck/vvt");
  return { ok: true, values: input };
}
