"use server";

// Verwaltung → System → Gerätezertifikate (P4-40b): Ausstellen, Sperren, Regeln für den Zugriff von außen.
// Recht `verwaltung.system`; alles nur im Schulnetz (Prüfung im Service an der Zone der Anfrage).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { issueDeviceCert, VALIDITY_DAYS } from "@/core/device-certs/issue";
import { DeviceCertError, REVOKE_REASONS, revokeDeviceCert, saveExternalSettings, type RevokeReason } from "@/core/device-certs/service";
import { StepCaError, stepCaConfig } from "@/core/device-certs/step-ca";
import { externalZone } from "@/core/external-access";
import { readSchoolSettings } from "@/core/settings";

const PATH = "/verwaltung/system/geraete";

export interface GeraeteState {
  ok?: string;
  error?: string;
}

export interface IssueState extends GeraeteState {
  issued?: { commonName: string; label: string; fingerprint: string; notAfter: string; password: string; p12: string; mobileconfig: string };
}

function failure(err: unknown): GeraeteState {
  if (err instanceof DeviceCertError || err instanceof StepCaError) return { error: err.message };
  throw err;
}

export async function saveExternalSettingsAction(_prev: GeraeteState, form: FormData): Promise<GeraeteState> {
  const { user } = await requirePermission("verwaltung.system");
  const staff = form.get("personal");
  const admin = form.get("verwaltung");
  try {
    await saveExternalSettings(await getDb(), user.id, externalZone(await headers()), {
      staffCert: staff === "an" || staff === "aus" ? staff : null,
      adminAllowed: admin === "erlaubt" ? true : admin === "gesperrt" ? false : null,
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath(PATH);
  return { ok: "Regeln gespeichert – sie gelten ab der nächsten Anfrage." };
}

export async function issueDeviceCertAction(_prev: IssueState, form: FormData): Promise<IssueState> {
  const { user } = await requirePermission("verwaltung.system");
  const db = await getDb();
  try {
    const ca = stepCaConfig();
    const label = String(form.get("label") ?? "");
    const r = await issueDeviceCert(
      db,
      user.id,
      externalZone(await headers()),
      { label, days: Number(form.get("tage") ?? VALIDITY_DAYS.default), username: String(form.get("konto") ?? ""), organization: (await readSchoolSettings(db)).name },
      ca,
    );
    revalidatePath(PATH);
    return {
      ok: "Zertifikat ausgestellt.",
      issued: {
        commonName: r.commonName,
        label: label.trim(),
        fingerprint: r.fingerprint,
        notAfter: r.notAfter.toISOString(),
        password: r.password,
        p12: r.p12.toString("base64"),
        mobileconfig: r.mobileconfig.toString("base64"),
      },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function revokeDeviceCertAction(_prev: GeraeteState, form: FormData): Promise<GeraeteState> {
  const { user } = await requirePermission("verwaltung.system");
  const reason = String(form.get("grund") ?? "");
  try {
    await revokeDeviceCert(await getDb(), user.id, externalZone(await headers()), String(form.get("id") ?? ""), (reason in REVOKE_REASONS ? reason : "") as RevokeReason);
  } catch (err) {
    return failure(err);
  }
  revalidatePath(PATH);
  return { ok: "Gesperrt – das Gerät kommt ab sofort nicht mehr von außen herein." };
}
