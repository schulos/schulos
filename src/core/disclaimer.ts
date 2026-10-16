// REPO-03: Vorschau-/Haftungshinweis in der Web-Oberfläche. Ein Admin (Recht `verwaltung.system`) bestätigt ihn einmal je
// Fassung (`DISCLAIMER_VERSION`); bis dahin zeigt die Shell allen mit diesem Recht ein Band. Unter Verwaltung → System steht
// der Hinweis dauerhaft – so kommt er auch per Update auf bestehende Server. Gespeichert wird nur Fassung + Zeitpunkt
// (app_settings, kein Personenbezug); wer bestätigt hat, steht im Audit-Log (`system.disclaimer.ack`).
import { eq } from "drizzle-orm";
import { DISCLAIMER_VERSION } from "@schulos/server/disclaimer";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";

export const DISCLAIMER_KEY = "system.disclaimer_ack";

export interface DisclaimerAck {
  version: number;
  at: string;
}

function parse(value: unknown): DisclaimerAck | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.version === "number" && typeof v.at === "string"
    ? { version: v.version, at: v.at }
    : null;
}

/** Bestätigung der aktuellen Fassung, sonst null (auch bei älterer Fassung). */
export async function readDisclaimerAck(db: Db): Promise<DisclaimerAck | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, DISCLAIMER_KEY));
  const ack = parse(row?.value);
  return ack && ack.version >= DISCLAIMER_VERSION ? ack : null;
}

/** Bestätigen (idempotent je Fassung); Rechteprüfung macht der Aufrufer. */
export async function ackDisclaimer(
  db: Db,
  actorId: string,
  now = new Date(),
): Promise<DisclaimerAck> {
  const existing = await readDisclaimerAck(db);
  if (existing) return existing;
  const ack: DisclaimerAck = {
    version: DISCLAIMER_VERSION,
    at: now.toISOString(),
  };
  await db
    .insert(appSettings)
    .values({ key: DISCLAIMER_KEY, value: ack })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: ack, updatedAt: now },
    });
  await audit(db, actorId, "system.disclaimer.ack", null, {
    version: DISCLAIMER_VERSION,
  });
  return ack;
}
