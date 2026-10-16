import { renderSVG } from "uqr";
import { secretFromUri } from "@schulos/server/two-factor";
import { audit } from "@/audit";
import type { Db } from "@/db/client";
import type { Auth } from "./auth";

// Zwei-Faktor-Anmeldung ist auf dem Backupserver für jedes Konto Pflicht – ausschalten geht nicht.
// Bei verlorenem Gerät hilft ein Wiederherstellungscode; Zurücksetzen durch einen anderen Admin kommt mit der Kontenverwaltung (B-25).

export interface SetupData {
  secret: string;
  qrSvg: string;
  backupCodes: string[];
}

/** Schritt 1: Geheimnis und Wiederherstellungscodes anlegen; aktiv erst mit dem ersten richtigen Code. */
export async function startSetup(auth: Auth, headers: Headers, password: string): Promise<SetupData> {
  const res = await auth.api.enableTwoFactor({ body: { password, method: "totp" }, headers });
  if (res.method !== "totp") throw new Error("TOTP erwartet");
  return { secret: secretFromUri(res.totpURI), qrSvg: renderSVG(res.totpURI, { border: 2 }), backupCodes: res.backupCodes };
}

export async function confirmSetup(db: Db, auth: Auth, headers: Headers, userId: string, code: string): Promise<void> {
  await auth.api.verifyTOTP({ body: { code: code.replace(/\s/g, "") }, headers });
  await audit(db, userId, "konto.2fa.eingerichtet", userId);
}

export async function regenerateBackupCodes(db: Db, auth: Auth, headers: Headers, userId: string, password: string): Promise<string[]> {
  const res = await auth.api.generateBackupCodes({ body: { password }, headers });
  await audit(db, userId, "konto.2fa.codes", userId);
  return res.backupCodes;
}
