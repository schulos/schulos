"use server";

// Verwaltung → Benutzer → Zwei-Faktor-Anmeldung (SEC-01/SEC-02): Einrichtung von außen freigeben, Code-Liste erzeugen.
// Recht `verwaltung.zwei_faktor` (Vorgabe Rolle Verwaltung = Sekretariat); Konten mit mehr Rechten nur durch Admins (Service).
import { revalidatePath } from "next/cache";
import { CodeListError, createCodeList } from "@/core/auth/codeliste";
import { requirePermission } from "@/core/auth/session";
import { releaseExternalSetup, TwoFactorSetupError } from "@/core/auth/zwei-faktor";
import { getDb } from "@/core/db/client";
import { ValidationError } from "./users";

export interface TwoFactorAdminState {
  ok?: string;
  error?: string;
  /** SEC-02: frisch erzeugte Codes – nur in dieser Antwort, danach nie wieder lesbar */
  codes?: string[];
}

function failure(err: unknown): TwoFactorAdminState {
  if (err instanceof TwoFactorSetupError || err instanceof CodeListError) return { error: err.message };
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich." };
  throw err;
}

const when = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

/** Q-5A-30: Person darf die 2FA 48 Stunden lang auch von außerhalb des Schulnetzes einrichten. */
export async function releaseExternalSetupAction(id: string): Promise<TwoFactorAdminState> {
  const { user } = await requirePermission("verwaltung.zwei_faktor");
  if (id === user.id) return { error: "Das eigene Konto lässt sich hier nicht freigeben." };
  try {
    const until = await releaseExternalSetup(await getDb(), user.id, id);
    revalidatePath(`/verwaltung/benutzer/${id}`);
    return { ok: `Freigegeben bis ${when.format(until)}.` };
  } catch (err) {
    return failure(err);
  }
}

/** SEC-02: neue Code-Liste (ersetzt die alte) – die Codes kommen genau einmal zum Drucken zurück. */
export async function createCodeListAction(id: string): Promise<TwoFactorAdminState> {
  const { user } = await requirePermission("verwaltung.zwei_faktor");
  if (id === user.id) return { error: "Für das eigene Konto gibt es keine Code-Liste." };
  try {
    const codes = await createCodeList(await getDb(), user.id, id);
    revalidatePath(`/verwaltung/benutzer/${id}`);
    return { ok: "Neue Code-Liste erzeugt – die alte gilt nicht mehr.", codes };
  } catch (err) {
    return failure(err);
  }
}
