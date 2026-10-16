"use server";

// Verwaltung → System → Anmeldung (SEC-01, P4-71): Schulnetz, Stichtag der 2FA-Pflicht, Inaktivitätsablauf. Recht
// `verwaltung.system`, nur aus dem Schulnetz (Prüfung im Service an der Anfrage).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { saveSecuritySettings, SecuritySettingsError } from "@/core/auth/anmelde-einstellungen";
import { requestNetwork } from "@/core/auth/pflicht";
import { forwardedClientIp, trustedProxies } from "@/core/auth/schulnetz";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";

export interface AnmeldungState {
  ok?: string;
  error?: string;
  /** G4E-C02: eigene Adresse läge außerhalb – Bestätigung anbieten */
  confirmOutside?: string;
  /** Eingaben nach einem Fehler (das Formular wird nach der Action zurückgesetzt) */
  values?: { schulnetz: string; stichtag: string; inaktiv: string };
}

export async function saveSecuritySettingsAction(_prev: AnmeldungState, form: FormData): Promise<AnmeldungState> {
  const { user } = await requirePermission("verwaltung.system");
  const db = await getDb();
  try {
    const h = await headers();
    await saveSecuritySettings(
      db,
      user.id,
      await requestNetwork(db, h),
      {
        schoolNets: String(form.get("schulnetz") ?? ""),
        twoFactorFrom: String(form.get("stichtag") ?? ""),
        idleMinutes: Number(form.get("inaktiv") ?? 0),
      },
      { clientIp: forwardedClientIp(h, trustedProxies()), confirmOwnAddressOutside: form.get("eigene_adresse_aussen") === "on" },
    );
  } catch (err) {
    if (err instanceof SecuritySettingsError)
      return {
        error: err.message,
        confirmOutside: err.ownAddressOutside ?? undefined,
        values: { schulnetz: String(form.get("schulnetz") ?? ""), stichtag: String(form.get("stichtag") ?? ""), inaktiv: String(form.get("inaktiv") ?? "0") },
      };
    throw err;
  }
  revalidatePath("/verwaltung/system/anmeldung");
  return { ok: "Gespeichert – gilt ab der nächsten Anfrage." };
}
