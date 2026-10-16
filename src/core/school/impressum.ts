// Impressum (P4-33, Q5-22): öffentliche Seite /impressum für die öffentlichen Seiten (Schulanmeldung). Angaben nach § 5 DDG
// als einzelne Felder in app_settings („school.impressum.fields“), gepflegt unter Verwaltung → Schule. Ob die Angaben im
// Einzelfall genügen, prüft die Schule (Vorlage, keine Rechtsberatung).
//
// Übernahme des bisherigen Freitexts (P4-33, Schlüssel „school.impressum“): er bleibt gespeichert und wird öffentlich
// angezeigt, bis alle Pflichtfelder ausgefüllt sind; beim ersten vollständigen Speichern wird er entfernt.
import { eq, inArray } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { IMPRESSUM_FIELD_DEFS, missingImpressumFields, type ImpressumFieldKey, type ImpressumFields } from "./impressum-fields";

export * from "./impressum-fields";

export const IMPRESSUM_FIELDS_KEY = "school.impressum.fields";
/** Freitext aus P4-33 – nur noch gelesen (Übernahme), nie neu geschrieben. */
export const IMPRESSUM_LEGACY_KEY = "school.impressum";

export interface Impressum {
  fields: ImpressumFields;
  /** bisheriger Freitext (P4-33), solange die Felder nicht vollständig sind */
  legacyText: string;
  complete: boolean;
  /** Beschriftungen der fehlenden Pflichtfelder */
  missing: string[];
}

const clean = (v: unknown, multiline = false) =>
  typeof v !== "string" ? "" : multiline ? v.replace(/\r\n/g, "\n").trim() : v.replace(/\s+/g, " ").trim();

function parseFields(value: unknown): ImpressumFields {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(IMPRESSUM_FIELD_DEFS.map((d) => [d.key, clean(obj[d.key], d.multiline)])) as ImpressumFields;
}

export async function readImpressum(db: Db): Promise<Impressum> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [IMPRESSUM_FIELDS_KEY, IMPRESSUM_LEGACY_KEY]));
  const fields = parseFields(rows.find((r) => r.key === IMPRESSUM_FIELDS_KEY)?.value);
  const legacy = rows.find((r) => r.key === IMPRESSUM_LEGACY_KEY)?.value;
  const missing = missingImpressumFields(fields);
  return { fields, legacyText: typeof legacy === "string" ? legacy : "", complete: missing.length === 0, missing };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()/ .-]{5,40}$/;

/**
 * Speichert die Felder (auch unvollständig – die Vollständigkeit prüft `assertImpressumComplete`). Formatfehler und
 * Überlängen werfen ValidationError. Sind danach alle Pflichtfelder gefüllt, wird der bisherige Freitext entfernt.
 */
export async function saveImpressum(db: Db, actorId: string, input: Partial<Record<ImpressumFieldKey, string>>): Promise<Impressum> {
  const fields = parseFields(input);
  const fe: Record<string, string> = {};
  for (const d of IMPRESSUM_FIELD_DEFS) if (fields[d.key].length > d.max) fe[d.key] = `höchstens ${d.max} Zeichen`;
  if (fields.postalCode && !/^\d{5}$/.test(fields.postalCode)) fe.postalCode = "fünfstellige Postleitzahl";
  if (fields.email && !EMAIL_RE.test(fields.email)) fe.email = "gültige E-Mail-Adresse angeben";
  if (fields.phone && !PHONE_RE.test(fields.phone)) fe.phone = "nur Ziffern, Leerzeichen und + ( ) / - .";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db
    .insert(appSettings)
    .values({ key: IMPRESSUM_FIELDS_KEY, value: fields })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: fields, updatedAt: new Date() } });
  const missing = missingImpressumFields(fields);
  let legacyRemoved = false;
  if (missing.length === 0) {
    const removed = await db.delete(appSettings).where(eq(appSettings.key, IMPRESSUM_LEGACY_KEY)).returning({ key: appSettings.key });
    legacyRemoved = removed.length > 0;
  }
  await audit(db, actorId, "verwaltung.schule.impressum", null, { vollstaendig: missing.length === 0, ...(legacyRemoved ? { freitext_entfernt: true } : {}) });
  return readImpressum(db);
}

/** Für das Veröffentlichen öffentlicher Seiten (Schulanmeldung): ohne vollständiges Impressum → ValidationError. */
export async function assertImpressumComplete(db: Db, field = "verfahren"): Promise<void> {
  const { missing } = await readImpressum(db);
  if (missing.length)
    throw new ValidationError({ [field]: `Das Impressum ist unvollständig (fehlt: ${missing.join(", ")}) – bitte zuerst unter Verwaltung → Schule ergänzen` });
}
