import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { classbookEntries, groupMembers, groups, recordArchives, schoolYears, schoolYearTransitions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { planDeletion, runDeletion } from "@/core/privacy/loeschlauf";
import { readZip } from "@/core/zip";
import { confirmHandover, destroyEarliest, exportClassbookArchive } from "@/modules/klassenbuch/archiv";
import { readableClasses } from "@/modules/klassenbuch/service";
import { listGroups } from "./groups";
import { addNextSchoolYear } from "./school-years";
import {
  archiveStatus,
  archiveYearGroups,
  completeTransition,
  confirmReview,
  LEAVE,
  nextStep,
  planPromotion,
  promote,
  promotedName,
  resolvePromotion,
  startTransition,
} from "./schuljahreswechsel";
import { ValidationError } from "./users";

const sek1 = (code: string) => ({ code, stage: "sek1" });
const ober = (code: string) => ({ code, stage: "oberstufe" });

describe("Schuljahreswechsel (rein)", () => {
  it("promotedName: Jahrgang im Namen ersetzen, beim Stufenwechsel Jahrgangsname", () => {
    expect(promotedName("Klasse 7b", sek1("7"), sek1("8"))).toBe("Klasse 8b");
    expect(promotedName("7b", sek1("7"), sek1("8"))).toBe("8b");
    expect(promotedName("17er", sek1("7"), sek1("8"))).toBe("17er (8)");
    expect(promotedName("Klasse 10a", sek1("10"), ober("EF"))).toBe("EF");
    expect(promotedName("Jahrgang EF", ober("EF"), ober("Q1"))).toBe("Jahrgang Q1");
  });

  it("nextStep folgt der Reihenfolge des Assistenten", () => {
    const t = { promotedAt: null, archivedAt: null, reviewedAt: null, completedAt: null };
    const d = new Date();
    expect(nextStep(t, 3)).toBe("promote");
    expect(nextStep({ ...t, promotedAt: d }, 3)).toBe("archive_export");
    expect(nextStep({ ...t, promotedAt: d }, 0)).toBe("archive_groups");
    expect(nextStep({ ...t, promotedAt: d, archivedAt: d }, 0)).toBe("review");
    expect(nextStep({ ...t, promotedAt: d, archivedAt: d, reviewedAt: d }, 0)).toBe("complete");
    expect(nextStep({ ...t, completedAt: d }, 0)).toBe("done");
  });

  it("frühestes Vernichtungsdatum: 31.12. des Abschlussjahres + 10", () => {
    expect(destroyEarliest("2027-07-31")).toBe("2037-12-31");
  });

  it("resolvePromotion: Abweichungen nur in Klassen, die es gibt; Jahrgänge mischen sich nicht", () => {
    const plan = [
      { groupId: "a", name: "6b", gradeLevel: 6, gradeCode: "6", leaders: [], students: [{ id: "s1", name: "S1" }], proposal: "7b", proposalSlug: "7b" },
      { groupId: "b", name: "7b", gradeLevel: 7, gradeCode: "7", leaders: [], students: [{ id: "s2", name: "S2" }, { id: "s3", name: "S3" }], proposal: "8b", proposalSlug: "8b" },
    ];
    const levels = [6, 7, 8].map((level) => ({ level }));
    const ok = resolvePromotion(plan, { classes: [], overrides: { s2: "7b", s3: LEAVE } }, levels);
    expect(ok.assignment.get("s2")).toBe("7b");
    expect(ok.assignment.get("s3")).toBe(LEAVE);
    expect(() => resolvePromotion(plan, { classes: [], overrides: { s2: "9z" } }, levels)).toThrow(ValidationError);
    expect(() => resolvePromotion(plan, { classes: [{ groupId: "b", toName: "7b", keepLeaders: true }], overrides: {} }, levels)).toThrow(ValidationError);
  });
});

describe("Schuljahreswechsel (Demo-Schule)", () => {
  let h: DbHandle;
  let fromId: string;
  let toId: string;
  let tid: string;
  let lea: string;
  let q2Student: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    fromId = cur!.id;
    toId = await addNextSchoolYear(h.db, "u-admin", "2027-06-01");
    lea = (await h.db.select({ id: users.id }).from(users).where(eq(users.username, "lea.schaefer")))[0]!.id;
    const [q2] = await h.db.select({ id: groupMembers.userId }).from(groupMembers).innerJoin(users, eq(users.id, groupMembers.userId)).where(and(eq(groupMembers.groupId, "g-q2"), eq(users.role, "schueler")));
    q2Student = q2!.id;
  });
  afterAll(() => h.close());

  it("Start nur in ein späteres Schuljahr; zweiter Start liefert denselben Durchlauf", async () => {
    await expect(startTransition(h.db, "u-admin", fromId, fromId)).rejects.toThrow(ValidationError);
    tid = await startTransition(h.db, "u-admin", fromId, toId);
    expect(await startTransition(h.db, "u-admin", fromId, toId)).toBe(tid);
  });

  it("Plan: Klassen mit Vorschlag, Abschlussjahrgang ohne", async () => {
    const plan = await planPromotion(h.db, fromId);
    const by = (slug: string) => plan.find((p) => p.groupId === `g-${slug}`)!;
    expect(by("7b").proposal).toBe("Klasse 8b");
    expect(by("7b").leaders.map((l) => l.id)).toEqual(["u-jana.brandt"]);
    expect(by("10a").proposal).toBe("EF");
    expect(by("ef").proposal).toBe("Jahrgang Q1");
    expect(by("q2").proposal).toBeNull();
    expect(by("7b").students.some((s) => s.id === lea)).toBe(true);
  });

  it("Versetzung: neue Klassen im neuen Jahr, Wiederholerin, Parallelklassen laufen zusammen, Abschluss geht ab", async () => {
    const res = await promote(h.db, "u-admin", tid, { classes: [], overrides: { [lea]: "Klasse 7b" } });
    const newGroups = await h.db.select().from(groups).where(eq(groups.schoolYearId, toId));
    const g = (name: string) => newGroups.find((x) => x.name === name)!;
    expect(g("Klasse 8b")).toMatchObject({ slug: "8b", gradeLevel: 8 });
    expect(g("EF")).toMatchObject({ slug: "ef", gradeLevel: 11 });
    expect(g("Jahrgang Q2")).toMatchObject({ gradeLevel: 13 });
    expect(newGroups.every((x) => x.gradeLevel != null && x.gradeLevel <= 13)).toBe(true);
    // altes „8b“/„ef“ hat den Kurznamen mit Schuljahr bekommen
    expect((await h.db.select({ slug: groups.slug }).from(groups).where(eq(groups.id, "g-8b")))[0]!.slug).toBe("8b-2026-27");
    const members = async (id: string) => (await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, id))).map((m) => `${m.userId}:${m.role}`);
    expect(await members(g("Klasse 8b").id)).toContain("u-jana.brandt:leader");
    expect(await members(g("Klasse 7b").id)).toContain(`${lea}:member`);
    expect(await members(g("Klasse 8b").id)).not.toContain(`${lea}:member`);
    expect((await members(g("EF").id)).length).toBeGreaterThan(40);
    expect(res.leavers).toContain(q2Student);
    await expect(promote(h.db, "u-admin", tid, { classes: [], overrides: {} })).rejects.toThrow(ValidationError);
  });

  it("Archivieren erst nach dem Export der Klassenbücher; Export mit Fristen und Vermerk", async () => {
    await expect(archiveYearGroups(h.db, "u-admin", tid)).rejects.toMatchObject({ fieldErrors: { transition: expect.stringMatching(/exportieren/) } });
    const status = await archiveStatus(h.db, fromId);
    expect(status.length).toBeGreaterThan(0);
    for (const s of status) {
      const { filename, zip } = await exportClassbookArchive(h.db, "u-admin", s.id);
      expect(filename).toMatch(/^Klassenbuch_.*\.zip$/);
      if (s.id !== "g-7b") continue;
      const files = readZip(zip);
      // DS-16: Vorgabe „digitale Meldung gilt als schriftliche Entschuldigung“ → eigener Teil „Entschuldigungen“
      expect([...files.keys()].sort()).toEqual(["LIESMICH.txt", "entschuldigungen.html", "entschuldigungen.json", "klassenbuch.html", "klassenbuch.json", "metadaten.json"]);
      const meta = JSON.parse(new TextDecoder().decode(files.get("metadaten.json")));
      expect(meta).toMatchObject({ schuljahr: "2026/27", klasse: "Klasse 7b", abschlussdatum: "2027-07-31", fruehestesVernichtungsdatum: "2037-12-31" });
      expect(meta.vermerk).toMatch(/Archiv anzubieten/);
      const data = JSON.parse(new TextDecoder().decode(files.get("klassenbuch.json")));
      expect(data.schueler.some((x: { name: string }) => x.name === "Lea Schäfer")).toBe(true);
      expect(data.eintraege.length).toBe(s.entries);
    }
    expect((await archiveStatus(h.db, fromId)).every((s) => s.archive && !s.archive.handedOverAt)).toBe(true);
  });

  it("Archivieren: Mitgliedschaften enden, Gruppen verschwinden aus Listen", async () => {
    const n = await archiveYearGroups(h.db, "u-admin", tid);
    expect(n).toBeGreaterThan(10);
    expect(await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, "g-7b"))).toEqual([]);
    expect((await listGroups(h.db)).some((g) => g.id === "g-7b")).toBe(false);
    expect((await listGroups(h.db, { archived: true })).some((g) => g.id === "g-7b")).toBe(true);
    const classes = await readableClasses(h.db, await loadPermissions(h.db, "u-petra.lindner"));
    expect(classes.some((c) => c.id === "g-7b")).toBe(false);
    expect(classes.some((c) => c.name === "Klasse 8b")).toBe(true);
    // Klassenbuch-Einträge bleiben (Akte)
    expect((await h.db.select().from(classbookEntries).where(eq(classbookEntries.groupId, "g-7b"))).length).toBeGreaterThan(0);
  });

  it("Prüfschritt ist Pflicht; Abschluss macht das neue Jahr aktuell und meldet Abgänger:innen ab", async () => {
    await expect(completeTransition(h.db, "u-admin", tid)).rejects.toThrow(ValidationError);
    await expect(confirmReview(h.db, "u-admin", tid, false)).rejects.toThrow(ValidationError);
    await confirmReview(h.db, "u-petra.lindner", tid, true);
    const { left } = await completeTransition(h.db, "u-admin", tid);
    expect(left).toBeGreaterThan(10);
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    expect(cur!.id).toBe(toId);
    expect((await h.db.select().from(users).where(eq(users.id, q2Student)))[0]).toMatchObject({ status: "locked", leftOn: "2027-07-31" });
    expect((await h.db.select().from(users).where(eq(users.id, lea)))[0]).toMatchObject({ status: "active", leftOn: null });
    const [t] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(t).toMatchObject({ reviewedBy: "u-petra.lindner" });
    expect(t!.completedAt).not.toBeNull();
    await expect(archiveYearGroups(h.db, "u-admin", tid)).rejects.toMatchObject({ fieldErrors: { transition: expect.stringMatching(/abgeschlossen/) } });
  });

  it("Löschlauf: Gruppe mit Klassenbuch bleibt, bis der Export übergeben ist – dann geht die Akte mit", async () => {
    const day = "2028-09-01";
    const groupsDue = async () => {
      const plan = await planDeletion(h.db, day);
      return plan.find((p) => p.table === "groups")!.count;
    };
    // vor der Übergabe ist 7b (mit Klassenbuch) nicht fällig, obwohl das Schuljahr über ein Jahr zurückliegt
    const before = await groupsDue();
    expect((await h.db.select().from(groups).where(eq(groups.id, "g-7b"))).length).toBe(1);
    await confirmHandover(h.db, "u-admin", "g-7b");
    expect(await groupsDue()).toBe(before + 1);
    await runDeletion(h.db, null, day);
    expect(await h.db.select().from(groups).where(eq(groups.id, "g-7b"))).toEqual([]);
    expect(await h.db.select().from(classbookEntries).where(eq(classbookEntries.groupId, "g-7b"))).toEqual([]);
    // Nachweis bleibt ohne Gruppe
    const proof = await h.db.select().from(recordArchives).where(and(eq(recordArchives.groupName, "Klasse 7b"), isNull(recordArchives.groupId)));
    expect(proof).toHaveLength(1);
    expect(proof[0]!.handedOverAt).not.toBeNull();
  }, 60_000);
});
