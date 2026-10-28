// SP3-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.4, §4 „Vorlagen“): Änderungen während der Laufzeit über eine Folgeversion und der
// Halbjahreswechsel als Vorlage. Beide Vorlagen legen einen Entwurf aus dem gültigen Plan an (`live_copy`, Herkunft je Stunde) – der weitere
// Weg ist der normale: bearbeiten, Diff ansehen, Prüfung → Freigabe (F-10-3: auch Folgeversionen) → Veröffentlichen. Die Vorlage
// „Neues Halbjahr“ ersetzt „Periode kopieren“ (P2b-14): der gültige Plan wird nicht mehr direkt geteilt, die Teilung übernimmt das
// Veröffentlichen ab dem Stichtag (Klassenbuch, Vertretungen und Material davor bleiben an den bisherigen Stunden).
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { createDraft, ensureBaseVersions, nextNumber, validVersion, versionNumber } from "./planversionen";
import type { TimetablePlanVersion } from "./schema";

export const PLAN_TEMPLATES = ["aenderung", "halbjahr"] as const;
export type PlanTemplate = (typeof PLAN_TEMPLATES)[number];

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const fmt = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

/** Eine Vorlage, wie sie die Versionsliste anbietet: Stichtag und Nummer, sonst der Grund, warum sie gerade nicht geht. */
export type TemplateOffer = { ok: true; validFrom: string; number: string; name: string } | { ok: false; reason: string };

/**
 * Was die Vorlagen im Schuljahr gerade anbieten (§4):
 * - **Änderung im laufenden Plan**: Folgeversion (`x.(y+1)`) der gültigen Version ab dem nächsten Schultag (im Schuljahr).
 * - **Neues Halbjahr**: neue Planung (`(x+1).0`) ab dem Beginn des 2. Halbjahrs (`term2_starts_on`, bzw. dem ersten Schultag ab dann), solange
 *   er noch bevorsteht – Lehraufträge, Setzhilfe und Solver-Lauf rechnen im Entwurf an diesem Stichtag (SP2-09, „Lehraufträge am“).
 */
export async function templateOffers(db: Db, year: { id: string; startsOn: string; endsOn: string; term2StartsOn: string | null }, today: string): Promise<Record<PlanTemplate, TemplateOffer>> {
  const cal = await loadSchoolCalendar(db);
  const valid = await validVersion(db, year.id);
  const inYear = (d: string) => d >= year.startsOn && d <= year.endsOn;
  let aenderung: TemplateOffer;
  const minor = await nextNumber(db, year.id, "minor");
  if (!valid || !minor) aenderung = { ok: false, reason: "Es gibt noch keinen gültigen Plan in diesem Schuljahr." };
  else {
    const d = cal.nextSchoolDay(addDays(today < year.startsOn ? addDays(year.startsOn, -1) : today, 1));
    aenderung = inYear(d) ? { ok: true, validFrom: d, number: versionNumber(minor), name: `Änderung ab ${fmt(d)}` } : { ok: false, reason: "Das Schuljahr hat keinen Schultag mehr." };
  }
  let halbjahr: TemplateOffer;
  const major = await nextNumber(db, year.id, "major");
  if (!year.term2StartsOn) halbjahr = { ok: false, reason: "Für das Schuljahr ist kein Beginn des 2. Halbjahrs eingetragen (Stammdaten → Schuljahr)." };
  else if (!valid) halbjahr = { ok: false, reason: "Es gibt noch keinen gültigen Plan in diesem Schuljahr." };
  else {
    const d = cal.nextSchoolDay(year.term2StartsOn);
    halbjahr =
      d > today && inYear(d)
        ? { ok: true, validFrom: d, number: versionNumber(major!), name: "2. Halbjahr" }
        : { ok: false, reason: `Das 2. Halbjahr hat schon begonnen (${fmt(year.term2StartsOn)}).` };
  }
  return { aenderung, halbjahr };
}

/** Entwurf aus einer Vorlage anlegen (`live_copy`, Nummer und Stichtag aus der Vorlage). */
export async function createFromTemplate(db: Db, actorId: string, schoolYearId: string, template: PlanTemplate, today: string): Promise<TimetablePlanVersion> {
  if (!(PLAN_TEMPLATES as readonly string[]).includes(template)) throw new ValidationError({ template: "Vorlage wählen" });
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, schoolYearId));
  if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
  await ensureBaseVersions(db, today);
  const offer = (await templateOffers(db, year, today))[template];
  if (!offer.ok) throw new ValidationError({ template: offer.reason });
  return createDraft(
    db,
    actorId,
    { schoolYearId, source: "live_copy", validFrom: offer.validFrom, numbering: template === "aenderung" ? "minor" : "major", name: offer.name },
    today,
  );
}
