// Kurswahlen (P4-63): Zuteilung ausführen, Korrektur von Hand, Statistik. Die Logik selbst ist rein (`zuteilung.ts`);
// hier werden Wahlen gelesen, Ergebnisse gespeichert und der Seed des Loses protokolliert.
import { and, eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { kurswahlVerfahren, kurswahlWahlen, type KurswahlVerfahren, type KurswahlWahl } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { MANAGE, getVerfahren, listAngebote, neededChoices, targetStudents } from "./service";
import { allocate, demand, type AllocPlace, type AllocStudent, type AllocationResult, type Demand } from "./zuteilung";

/** Eingaben der Zuteilung: Angebote, abgegebene Wahlen der Zielgruppe und Zuteilungen von Hand. */
async function inputs(db: Db, v: KurswahlVerfahren) {
  const [offers, target, wahlen] = await Promise.all([listAngebote(db, v.id), targetStudents(db, v), db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, v.id))]);
  const inTarget = new Set(target.map((t) => t.id));
  // P4-67: je Person die Plätze (Zeile je Platz); fehlende Plätze dazwischen bleiben leer
  const rows = new Map<string, typeof wahlen>();
  for (const w of wahlen) rows.set(w.studentId, [...(rows.get(w.studentId) ?? []), w]);
  const placesFor = (id: string, onlyManual: boolean): AllocPlace[] => {
    // G4E-C04: Plätze über der Höchstzahl zählen nie (Altbestand bzw. gleichzeitiges Senken)
    const list = (rows.get(id) ?? []).filter((w) => w.place <= v.maxCourses);
    const n = Math.max(0, ...list.map((w) => w.place));
    return Array.from({ length: n }, (_, i) => {
      const w = list.find((x) => x.place === i + 1);
      return { choices: !onlyManual && w?.submittedAt ? w.choices : [], manual: w?.manual ? w.assignedId : null };
    });
  };
  const student = (id: string, onlyManual: boolean): AllocStudent => {
    const places = placesFor(id, onlyManual);
    return { id, choices: places[0]?.choices ?? [], manual: places[0]?.manual ?? null, places: places.length ? places : undefined };
  };
  // Reihenfolge der Personen: wie die Zielgruppe (Klasse, Name) – das Los hängt davon nicht ab
  const students = target.map((t) => student(t.id, false));
  // Von Hand Zugeteilte außerhalb der Zielgruppe (z. B. Wechsel der Klasse) bleiben fest
  for (const id of rows.keys()) if (!inTarget.has(id) && rows.get(id)!.some((w) => w.manual)) students.push(student(id, true));
  return { offers, students, wahlen };
}

/**
 * G4E-C05 (rein): Zeilen der Zuteilungsliste. Bei Mehrfachwahl je Person alle Plätze 1 … Höchstzahl – fehlende als „offen“, damit
 * sich auch ein freiwilliger bzw. nicht gewählter Platz von Hand zuteilen lässt; bei einem Kurs je Person wie bisher eine Zeile.
 */
export function assignmentLines<R extends { wahl: KurswahlWahl | null; places: KurswahlWahl[] }>(rows: readonly R[], maxCourses: number) {
  return rows.flatMap((r) =>
    maxCourses <= 1
      ? [{ r, w: r.wahl, place: 1 }]
      : Array.from({ length: maxCourses }, (_, i) => ({ r, w: r.places.find((p) => p.place === i + 1) ?? null, place: i + 1 })),
  );
}

const asAlloc = (offers: Awaited<ReturnType<typeof listAngebote>>) => offers.map((o) => ({ id: o.id, title: o.title, minSize: o.minSize, maxSize: o.maxSize }));

/**
 * Zuteilung berechnen und speichern (bis zur Übernahme). Ohne `newSeed` gilt der gespeicherte Seed – dieselben Wahlen
 * ergeben dann dasselbe Ergebnis. Von Hand Zugeteilte bleiben, wie sie sind.
 */
export async function runAllocation(db: Db, perms: PermissionSet, verfahrenId: string, opts: { newSeed?: boolean } = {}, now = new Date()): Promise<AllocationResult> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ seed: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (v.transferredAt) throw new ValidationError({ seed: "Schon in Gruppen übernommen – die Zuteilung steht fest" });
  const { offers, students, wahlen } = await inputs(db, v);
  if (offers.length === 0) throw new ValidationError({ seed: "Noch keine Angebote" });
  const seed = !opts.newSeed && v.allocationSeed ? v.allocationSeed : crypto.randomUUID().slice(0, 8);
  const result = allocate(asAlloc(offers), students, seed);
  const existing = new Set(wahlen.map((w) => `${w.studentId}#${w.place}`));
  await db.transaction(async (tx) => {
    for (const a of result.assignments) {
      const values = { assignedId: a.offerId, assignedRank: a.rank, reason: a.reason };
      if (existing.has(`${a.studentId}#${a.place}`)) {
        await tx
          .update(kurswahlWahlen)
          .set(values)
          .where(
            and(eq(kurswahlWahlen.verfahrenId, v.id), eq(kurswahlWahlen.studentId, a.studentId), eq(kurswahlWahlen.place, a.place), eq(kurswahlWahlen.manual, false)),
          );
      }
      // Nichtwähler ohne Zeile: es gibt nichts zuzuteilen – erst eine Zuteilung von Hand legt eine Zeile an
    }
    await tx.update(kurswahlVerfahren).set({ allocationSeed: seed, allocatedAt: now }).where(eq(kurswahlVerfahren.id, v.id));
  });
  await audit(db, perms.userId, "kurswahl.allocate", v.id, { seed, cancelled: result.offers.filter((o) => o.cancelled).length, unassigned: result.assignments.filter((a) => !a.offerId).length });
  return result;
}

/** Ergebnis der letzten Zuteilung erneut berechnen (rein, mit dem gespeicherten Seed) – für Protokoll und Ausfälle. */
export async function explainAllocation(db: Db, perms: PermissionSet, v: KurswahlVerfahren): Promise<AllocationResult | null> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  if (!v.allocationSeed) return null;
  const { offers, students } = await inputs(db, v);
  return allocate(asAlloc(offers), students, v.allocationSeed);
}

/**
 * Korrektur von Hand: Person einem Angebot zuteilen (`null` hebt die Zuteilung von Hand auf). P4-67: je Platz (1 … Höchstzahl
 * der Kurse); ein Kurs, den die Person auf einem anderen Platz schon hat, geht nicht noch einmal.
 */
export async function assignManually(db: Db, perms: PermissionSet, verfahrenId: string, studentId: string, offerId: string | null, place = 1): Promise<void> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ offerId: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (v.transferredAt) throw new ValidationError({ offerId: "Schon in Gruppen übernommen – Änderungen jetzt in den Gruppen" });
  const offers = await listAngebote(db, v.id);
  if (offerId && !offers.some((o) => o.id === offerId)) throw new ValidationError({ offerId: "Unbekanntes Angebot" });
  if (!Number.isInteger(place) || place < 1 || place > v.maxCourses) throw new ValidationError({ offerId: "Unbekannter Platz" });
  const all = await db
    .select()
    .from(kurswahlWahlen)
    .where(and(eq(kurswahlWahlen.verfahrenId, v.id), eq(kurswahlWahlen.studentId, studentId)));
  const w = all.find((x) => x.place === place);
  if (offerId && all.some((x) => x.place !== place && x.assignedId === offerId)) throw new ValidationError({ offerId: "Diesen Kurs hat die Person schon auf einem anderen Platz" });
  if (!w && !(await targetStudents(db, v)).some((t) => t.id === studentId)) throw new ValidationError({ offerId: "Diese Person gehört nicht zur Zielgruppe" });
  const rank = offerId && w?.submittedAt ? w.choices.indexOf(offerId) + 1 || null : null;
  const values = offerId
    ? { assignedId: offerId, assignedRank: rank, reason: rank ? `von Hand zugeteilt (${rank}. Wunsch)` : "von Hand zugeteilt", manual: true }
    : { assignedId: null, assignedRank: null, reason: "Zuteilung von Hand aufgehoben – bei der nächsten Zuteilung neu", manual: false };
  await db
    .insert(kurswahlWahlen)
    .values({ verfahrenId: v.id, studentId, place, ...values })
    .onConflictDoUpdate({ target: [kurswahlWahlen.verfahrenId, kurswahlWahlen.studentId, kurswahlWahlen.place], set: values });
  await audit(db, perms.userId, "kurswahl.assign", v.id, { manual: Boolean(offerId), ...(place > 1 ? { platz: place } : {}) });
}

export interface OfferStat {
  id: string;
  title: string;
  minSize: number;
  maxSize: number | null;
  demand: Demand;
  assigned: number;
}

/** Statistik: Nachfrage je Angebot und Rang (abgegebene Wahlen der Zielgruppe) und aktuell Zugeteilte. */
export async function statistics(db: Db, perms: PermissionSet, v: KurswahlVerfahren): Promise<OfferStat[]> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const { offers, students, wahlen } = await inputs(db, v);
  // P4-67: Nachfrage über alle Plätze (je Platz eine Wunschliste)
  const lists = students.flatMap((s) => (s.places ?? [{ choices: s.choices }]).map((p) => ({ choices: p.choices })));
  const d = demand(
    offers,
    lists.filter((s) => s.choices.length),
    neededChoices(v, offers.length),
  );
  const ids = offers.map((o) => o.id);
  const assigned = ids.length ? wahlen.filter((w) => w.place <= v.maxCourses && w.assignedId && ids.includes(w.assignedId)) : [];
  return offers.map((o, i) => ({ id: o.id, title: o.title, minSize: o.minSize, maxSize: o.maxSize, demand: d[i]!, assigned: assigned.filter((w) => w.assignedId === o.id).length }));
}
