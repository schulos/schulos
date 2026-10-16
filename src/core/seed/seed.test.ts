import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren, classbookAbsences, classbookEntries, fileNodes, groupMembers, groups, parentChild, schoolYears, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { can } from "@/core/permissions";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { readSchoolSettings } from "@/core/settings";
import { ANTRAG_STATUSES } from "@/modules/anmeldung/labels";
import { DEMO_STATUS_COUNTS, DEMO_TARGET_YEAR_ID, DEMO_VERFAHREN_ID } from "@/modules/anmeldung/seed";
import { capacitySummary, openVerfahren } from "@/modules/anmeldung/service";
import { pendingAdmissions } from "@/modules/anmeldung/uebernahme";
import { DEMO_BOARD_ID } from "@/modules/tafeln/seed";
import { DEMO_PASSWORD } from "./data";
import { seedDemoSchool, type SeedSummary } from "./seed";

describe("Demo-Seed „Gesamtschule am Lindenhof“", () => {
  let h: DbHandle;
  let summary: SeedSummary;
  let hash: string;
  let dir: string;
  let storage: FileStorage;
  beforeAll(async () => {
    hash = await hashPassword(DEMO_PASSWORD);
    h = await createTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-seed-"));
    storage = localStorage(dir);
    summary = await seedDemoSchool(h.db, { passwordHash: hash, storage });
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("legt mit Dateispeicher das Lindenhof-Logo (Logo, dunkle Variante, Symbol) und die Beispieltafel an", async () => {
    const { logos } = await readSchoolSettings(h.db);
    expect(Object.keys(logos).sort()).toEqual(["dark", "logo", "symbol"]);
    expect(logos.logo).toMatchObject({ mime: "image/svg+xml", width: 360, height: 96 });
    expect(logos.symbol).toMatchObject({ width: 96, height: 96 });
    const keys = (await storage.list()).map((f) => f.key).sort();
    const [board] = await h.db.select({ key: fileNodes.storageKey, name: fileNodes.name }).from(fileNodes).where(eq(fileNodes.id, DEMO_BOARD_ID));
    expect(board?.name).toBe("Brüche.excalidraw");
    expect(keys).toEqual([logos.logo!.key, logos.dark!.key, logos.symbol!.key, board!.key!].sort());
  });

  it("erzeugt die geplante Größe", () => {
    expect(summary.byRole.schueler).toBe(12 * 25 + 22 + 20 + 18);
    expect(summary.byRole.lehrkraft).toBe(28);
    expect(summary.byRole.admin).toBe(1);
    expect(summary.byRole.verwaltung).toBe(1);
    expect(summary.byRole.personal).toBe(1); // Hausmeister Klaus Berger (P4-10)
    expect(summary.byRole.beratung).toBe(1); // Schulsozialarbeit Nina Ostermann (Q5-17)
    expect(summary.byRole.eltern).toBeGreaterThan(200);
    expect(summary.byRole.eltern).toBeLessThan(summary.byRole.schueler);
  });

  it("jedes Kind hat mindestens ein Elternteil", async () => {
    const kids = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "schueler"));
    const links = await h.db.select().from(parentChild);
    const withParent = new Set(links.map((l) => l.childId));
    expect(kids.every((k) => withParent.has(k.id))).toBe(true);
  });

  it("Frau Brandt leitet die 7b, Lea ist drin", async () => {
    const rows = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, "g-7b"));
    expect(rows.find((r) => r.userId === "u-jana.brandt")?.role).toBe("leader");
    expect(rows.some((r) => r.userId === "u-lea.schaefer")).toBe(true);
    expect(rows.filter((r) => r.role === "member").length).toBeGreaterThanOrEqual(25);
  });

  it("legt alle Gruppenarten an", async () => {
    const kinds = new Set((await h.db.select({ kind: groups.kind }).from(groups)).map((g) => g.kind));
    expect([...kinds].sort()).toEqual(["ag", "fachschaft", "frei", "gremium", "klasse", "kurs"]); // frei: Hausmeisterei
  });

  it("Rechte: Schulleitung und Sekretariat dürfen verwalten, Lehrkräfte nicht", async () => {
    expect(await can(h.db, "u-petra.lindner", "verwaltung.users")).toBe(true);
    expect(await can(h.db, "u-sabine.kowalski", "verwaltung.access")).toBe(true);
    expect(await can(h.db, "u-jana.brandt", "verwaltung.access")).toBe(false);
    expect(await can(h.db, "u-admin", "verwaltung.rights")).toBe(true);
  });

  it("Demo-Login funktioniert", async () => {
    const auth = createAuth(h.db);
    const res = await auth.api.signInUsername({ body: { username: "lea.schaefer", password: DEMO_PASSWORD } });
    expect(res?.token).toBeTruthy();
  });

  it("ist deterministisch", async () => {
    const other = await createTestDb();
    await seedDemoSchool(other.db, { passwordHash: hash });
    const pick = (db: DbHandle["db"]) =>
      db.select({ id: users.id }).from(groupMembers).innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(eq(groupMembers.groupId, "g-q1-m-lk1"), eq(groupMembers.role, "member"))).orderBy(users.id);
    expect(await pick(other.db)).toEqual(await pick(h.db));
    await other.close();
  }, 60_000);

  it("Schulanmeldung (P4-41): offenes Verfahren „Klasse 5 – 2027/28“ mit Terminen und 30 Anträgen in allen Status", async () => {
    const [v] = await h.db.select().from(anmeldungVerfahren);
    expect(v).toMatchObject({ id: DEMO_VERFAHREN_ID, name: "Klasse 5 – 2027/28", status: "offen", targetSchoolYearId: DEMO_TARGET_YEAR_ID, targetGradeLevel: 5 });
    // öffentlich sichtbar und offen für Anmeldungen
    expect((await openVerfahren(h.db)).map((o) => o.id)).toEqual([DEMO_VERFAHREN_ID]);
    const [year] = await h.db.select().from(schoolYears).where(eq(schoolYears.id, DEMO_TARGET_YEAR_ID));
    expect(year).toMatchObject({ name: "2027/28", isCurrent: false });

    const antraege = await h.db.select().from(anmeldungAntraege);
    expect(antraege).toHaveLength(30);
    const summary = await capacitySummary(h.db, DEMO_VERFAHREN_ID);
    for (const [status, n] of DEMO_STATUS_COUNTS) expect(summary.byStatus[status], status).toBe(n);
    // alle Status außer „übernommen“ (das passiert erst im Schuljahreswechsel nach 2027/28)
    expect(ANTRAG_STATUSES.filter((s) => summary.byStatus[s] === 0)).toEqual(["uebernommen"]);
    expect(new Set(antraege.map((a) => a.seq)).size).toBe(30);
    expect(antraege.every((a) => a.parent1Email.endsWith("@example.org") || a.parentUserId)).toBe(true);

    // Termine: nie überbucht; „Termin vereinbart“ liegt vor uns, geprüfte/entschiedene Anträge hatten ihr Gespräch schon
    const slots = new Map((await h.db.select().from(anmeldungSlots)).map((s) => [s.id, s]));
    const perSlot = new Map<string, number>();
    for (const a of antraege) if (a.slotId) perSlot.set(a.slotId, (perSlot.get(a.slotId) ?? 0) + 1);
    for (const [id, n] of perSlot) expect(n).toBeLessThanOrEqual(slots.get(id)!.capacity);
    const now = new Date();
    for (const a of antraege) {
      if (a.status === "termin") expect(slots.get(a.slotId!)!.startsAt > now).toBe(true);
      if (["vollstaendig", "aufgenommen", "warteliste", "abgelehnt"].includes(a.status)) {
        expect(slots.get(a.slotId!)!.startsAt < now).toBe(true);
        expect(Object.values(a.checklist as Record<string, boolean>).filter(Boolean)).toHaveLength(4);
      }
      // Fristbeginn wie die Statusmaschine: unbestätigt/zurückgezogen gesetzt, sonst (Verfahren läuft noch) leer
      expect(a.retentionFrom !== null, a.status).toBe(a.status === "unbestaetigt" || a.status === "zurueckgezogen");
    }
    // ein Geschwisterkind kommt über das Elternkonto (P4-34b)
    const viaAccount = antraege.filter((a) => a.parentUserId);
    expect(viaAccount).toHaveLength(1);
    expect(viaAccount[0]).toMatchObject({ sibling: true, childLastName: "Schäfer" });
    // die aufgenommenen Kinder bietet der Schuljahreswechsel nach 2027/28 als Neuaufnahmen an
    expect(await pendingAdmissions(h.db, DEMO_TARGET_YEAR_ID)).toHaveLength(5);
    expect((await h.db.select().from(anmeldungEreignisse)).length).toBeGreaterThanOrEqual(30);
  });

  it("ohne Anmeldeverfahren (E2E): kein Schuljahr 2027/28, kein Verfahren", async () => {
    const other = await createTestDb();
    await seedDemoSchool(other.db, { passwordHash: hash, admissions: false });
    expect(await other.db.select().from(anmeldungVerfahren)).toEqual([]);
    expect(await other.db.select().from(schoolYears).where(eq(schoolYears.id, DEMO_TARGET_YEAR_ID))).toEqual([]);
    await other.close();
  }, 60_000);
});

describe("Demo-Stundenplan", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await seedDemoSchool(h.db, { passwordHash: await hashPassword(DEMO_PASSWORD) });
  }, 60_000);
  afterAll(() => h.close());

  it("ist kollisionsfrei für Lehrkräfte, Räume und Gruppen", async () => {
    const rows = await h.db.select().from(timetableLessons);
    for (const field of ["teacherId", "roomId", "groupId"] as const) {
      const seen = new Set<string>();
      for (const l of rows) {
        const k = `${l[field]}:${l.weekday}:${l.periodNr}`;
        expect(seen.has(k), `${field} doppelt: ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });

  it("jede Sek-I-Klasse hat ihre volle Stundentafel; gleiches Fach am Tag nur als Doppelstunde", async () => {
    const rows = await h.db.select().from(timetableLessons);
    for (const slug of ["5a", "7b", "10b"]) expect(rows.filter((l) => l.groupId === `g-${slug}`).length).toBeGreaterThanOrEqual(28);
    const perDay = new Map<string, number[]>();
    for (const l of rows) perDay.set(`${l.groupId}:${l.subjectId}:${l.weekday}`, [...(perDay.get(`${l.groupId}:${l.subjectId}:${l.weekday}`) ?? []), l.periodNr]);
    for (const [k, ps] of perDay) {
      expect(ps.length, k).toBeLessThanOrEqual(2);
      if (ps.length === 2) expect(Math.abs(ps[0]! - ps[1]!), k).toBe(1);
    }
  });

  it("kaum Freistunden in Sek-I-Klassen", async () => {
    const rows = (await h.db.select().from(timetableLessons)).filter((l) => /^g-\d/.test(l.groupId));
    let gaps = 0;
    for (const g of new Set(rows.map((l) => l.groupId))) {
      for (let d = 0; d < 5; d++) {
        const ps = rows.filter((l) => l.groupId === g && l.weekday === d).map((l) => l.periodNr);
        if (ps.length) gaps += Math.max(...ps) - Math.min(...ps) + 1 - ps.length;
      }
    }
    expect(gaps).toBeLessThanOrEqual(2);
  });

  it("Frau Brandt gibt in der 7b Deutsch und Englisch; Oberstufenkurse eines Jahrgangs liegen nie parallel", async () => {
    const rows = await h.db.select().from(timetableLessons);
    const sevenB = rows.filter((l) => l.groupId === "g-7b" && ["D", "E"].includes(l.subjectId));
    expect(new Set(sevenB.map((l) => l.teacherId))).toEqual(new Set(["u-jana.brandt"]));
    const q1 = rows.filter((l) => l.groupId.startsWith("g-q1-"));
    expect(new Set(q1.map((l) => `${l.weekday}:${l.periodNr}`)).size).toBe(q1.length);
    expect(q1.length).toBe(3 + 5 + 3 + 3); // E GK, M LK, D GK, BI GK
  });
});

describe("Demo-Vertretungen", () => {
  it("legt am nächsten Schultag eine Vertretung in der 7b und einen Entfall an, dazu ein Klassenbuch der 7b", async () => {
    const h = await createTestDb();
    await seedDemoSchool(h.db, { passwordHash: await hashPassword(DEMO_PASSWORD) });
    const subs = await h.db.select().from(timetableSubstitutions);
    expect(subs.map((s) => s.kind).sort()).toEqual(["cancel", "substitute"]);
    expect(subs.find((s) => s.kind === "substitute")!.substituteId).toBeTruthy();
    const entries = await h.db.select().from(classbookEntries);
    expect(entries.length).toBeGreaterThan(20);
    expect(new Set(entries.map((e) => e.groupId))).toEqual(new Set(["g-7b"]));
    const absences = await h.db.select().from(classbookAbsences);
    expect(absences.some((a) => a.excused === true) && absences.some((a) => a.excused === null) && absences.some((a) => a.kind === "late")).toBe(true);
    await h.close();
  }, 60_000);
});
