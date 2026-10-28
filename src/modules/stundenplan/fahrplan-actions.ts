"use server";

// SP3-06: Server Actions des Planungsfahrplans – Vorlage starten, Warnungen quittieren, Häkchen und Termine. Alles nur mit
// `stundenplan.manage`; die Schulleitung (`stundenplan.review`) sieht den Fahrplan nur lesend.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { moduleActions } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  acknowledgeWarnings,
  createEmptyFahrplan,
  createNewYearFahrplan,
  FAHRPLAN_STEPS,
  FAHRPLAN_TEMPLATES,
  pruneAcknowledgements,
  revokeAcknowledgement,
  setStepDate,
  setTick,
  type FahrplanStep,
  type FahrplanTemplate,
  type FahrplanTick,
} from "./fahrplan";
import { createFromTemplate } from "./laufzeit";

const { requirePermission } = moduleActions("stundenplan");

const PAGE = "/planung/fahrplan";
const firstError = (err: ValidationError) => Object.values(err.fieldErrors)[0] ?? "Das ging nicht";
const pageOf = (versionId: string, extra: Record<string, string> = {}, anchor?: string) =>
  `${PAGE}?${new URLSearchParams({ version: versionId, ...extra }).toString()}${anchor ? `#${anchor}` : ""}`;

function refresh() {
  revalidatePath(PAGE);
  revalidatePath("/planung");
}

/** Fahrplan mit einer Vorlage beginnen: „Neues Halbjahr“, „Änderung im laufenden Plan“ (SP3-05), „Leerer Entwurf“ oder „Neues Schuljahr“ (SP3-07, im Folgejahr). */
export async function startFahrplanAction(schoolYearId: string, template: FahrplanTemplate): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const db = await getDb();
  const today = toBerlinDate(new Date());
  let id: string;
  try {
    if (!(FAHRPLAN_TEMPLATES as readonly string[]).includes(template)) throw new ValidationError({ template: "Vorlage wählen" });
    if (template === "halbjahr" || template === "aenderung") id = (await createFromTemplate(db, user.id, schoolYearId, template, today)).id;
    else if (template === "leer") {
      const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, schoolYearId));
      if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
      id = (await createEmptyFahrplan(db, user.id, year, today)).id;
    } else {
      const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, schoolYearId));
      if (!year) throw new ValidationError({ schoolYearId: "Schuljahr wählen" });
      id = (await createNewYearFahrplan(db, user.id, year, today)).id;
    }
  } catch (err) {
    if (err instanceof ValidationError) redirect(`${PAGE}?${new URLSearchParams({ jahr: schoolYearId, fehler: firstError(err) }).toString()}`);
    throw err;
  }
  refresh();
  revalidatePath("/planung/versionen");
  redirect(pageOf(id, { angelegt: "1" }));
}

/** Schritt 7: gewählte Warnungen mit einer Begründung quittieren. */
export async function acknowledgeAction(versionId: string, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const keys = form.getAll("key").map(String);
  let n: number;
  try {
    n = await acknowledgeWarnings(await getDb(), user.id, versionId, keys, String(form.get("reason") ?? ""), toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(pageOf(versionId, { fehler: firstError(err) }, "schritt-pruefen"));
    throw err;
  }
  refresh();
  redirect(pageOf(versionId, { quittiert: String(n) }, "schritt-pruefen"));
}

/** Eine Quittierung zurücknehmen. */
export async function revokeAckAction(versionId: string, key: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await revokeAcknowledgement(await getDb(), user.id, versionId, key);
  } catch (err) {
    if (err instanceof ValidationError) redirect(pageOf(versionId, { fehler: firstError(err) }, "schritt-pruefen"));
    throw err;
  }
  refresh();
  redirect(pageOf(versionId, {}, "schritt-pruefen"));
}

/** Quittierungen entfernen, deren Warnung es nicht mehr gibt. */
export async function pruneAcksAction(versionId: string): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await pruneAcknowledgements(await getDb(), user.id, versionId, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) redirect(pageOf(versionId, { fehler: firstError(err) }, "schritt-pruefen"));
    throw err;
  }
  refresh();
  redirect(pageOf(versionId, {}, "schritt-pruefen"));
}

/** Manuelles Häkchen eines Schritts setzen bzw. entfernen. */
export async function tickAction(versionId: string, step: FahrplanStep, tick: FahrplanTick, on: boolean): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  try {
    await setTick(await getDb(), user.id, versionId, tick, on);
  } catch (err) {
    if (err instanceof ValidationError) redirect(pageOf(versionId, { fehler: firstError(err) }, `schritt-${step}`));
    throw err;
  }
  refresh();
  redirect(pageOf(versionId, {}, `schritt-${step}`));
}

/** Optionalen Termin eines Schritts setzen (leeres Feld bzw. „entfernen“ löscht ihn). */
export async function stepDateAction(versionId: string, step: FahrplanStep, form: FormData): Promise<void> {
  const { user } = await requirePermission("stundenplan.manage");
  const anchor = (FAHRPLAN_STEPS as readonly string[]).includes(step) ? `schritt-${step}` : undefined;
  const clear = form.get("clear") === "1";
  const date = clear ? null : String(form.get("date") ?? "").trim() || null;
  try {
    await setStepDate(await getDb(), user.id, versionId, step, date);
  } catch (err) {
    if (err instanceof ValidationError) redirect(pageOf(versionId, { fehler: firstError(err) }, anchor));
    throw err;
  }
  refresh();
  redirect(pageOf(versionId, {}, anchor));
}
