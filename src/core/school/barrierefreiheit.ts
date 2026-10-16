// Erklärung zur Barrierefreiheit (A11Y-02): Angaben der Schule in app_settings („school.barrierefreiheit“), gepflegt unter
// Verwaltung → Schule, öffentlich unter /barrierefreiheit. Kontakt fällt auf die E-Mail/Telefon aus dem Impressum zurück.
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { eq } from "drizzle-orm";
import { A11Y_FIELD_MAX, A11Y_STATUS, parseA11yStatement, type A11yStatement } from "./barrierefreiheit-fields";

export * from "./barrierefreiheit-fields";

export const A11Y_STATEMENT_KEY = "school.barrierefreiheit";

export async function readA11yStatement(db: Db): Promise<A11yStatement> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, A11Y_STATEMENT_KEY));
  return parseA11yStatement(row?.value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()/ .-]{5,40}$/;

/** Speichert die Angaben; Format- und Längenfehler werfen ValidationError (Feld → Meldung). */
export async function saveA11yStatement(db: Db, actorId: string, input: Record<string, unknown>): Promise<A11yStatement> {
  const fe: Record<string, string> = {};
  if (!A11Y_STATUS.includes(input.status as never)) fe.status = "Stand auswählen";
  const raw = typeof input.reviewedOn === "string" ? input.reviewedOn.trim() : "";
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) fe.reviewedOn = "Datum im Format JJJJ-MM-TT";
  const s = parseA11yStatement(input);
  for (const [k, max] of Object.entries(A11Y_FIELD_MAX)) if (s[k as keyof typeof A11Y_FIELD_MAX].length > max) fe[k] = `höchstens ${max} Zeichen`;
  if (s.contactEmail && !EMAIL_RE.test(s.contactEmail)) fe.contactEmail = "gültige E-Mail-Adresse angeben";
  if (s.contactPhone && !PHONE_RE.test(s.contactPhone)) fe.contactPhone = "nur Ziffern, Leerzeichen und + ( ) / - .";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db
    .insert(appSettings)
    .values({ key: A11Y_STATEMENT_KEY, value: s })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: s, updatedAt: new Date() } });
  await audit(db, actorId, "verwaltung.schule.barrierefreiheit", null, { stand: s.status });
  return s;
}
