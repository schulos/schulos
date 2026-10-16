import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { absenceReports, groupMembers, groups, parentChild, recordArchives, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { readZip } from "@/core/zip";
import { DIGITAL_WRITTEN } from "@/modules/abwesenheiten/settings";
import { confirmHandover, exportClassbookArchive } from "./archiv";
import { excusesDestroyEarliest } from "./entschuldigungen";

const LEA = "u-lea.schaefer";
// nach Ende des Schuljahres 2026/27 (31.07.2027): Meldungen aus dem Schuljahr sind nach LK-SJ fällig
const AFTER = "2027-09-01";

describe("DS-16: Entschuldigungen archivieren", () => {
  let h: DbHandle;
  const dueReports = async () => (await planDeletion(h.db, AFTER)).find((p) => p.table === "absence_reports")!;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const [{ parentId }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    await h.db.delete(absenceReports);
    await h.db.insert(absenceReports).values({ studentId: LEA, reportedBy: parentId, fromDate: "2026-11-03", toDate: "2026-11-04", reason: "krank", status: "entschuldigt", decidedBy: "u-jana.brandt", decidedAt: new Date() });
  }, 60_000);
  afterAll(() => h.close());

  it("Frist: 31.12. des Abschlussjahres + 5 Jahre", () => {
    expect(excusesDestroyEarliest("2027-07-31")).toBe("2032-12-31");
  });

  it("Vorgabe „ja“: eigener Teil im Archivexport, nicht in der Klassenbuch-Ansicht", async () => {
    const files = readZip((await exportClassbookArchive(h.db, "u-admin", "g-7b")).zip);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["entschuldigungen.json", "entschuldigungen.html"]));
    const ex = JSON.parse(new TextDecoder().decode(files.get("entschuldigungen.json")));
    expect(ex.meta).toMatchObject({ klasse: "Klasse 7b", fruehestesVernichtungsdatum: "2032-12-31" });
    expect(ex.entschuldigungen).toEqual([expect.objectContaining({ schueler: "Lea Schäfer", von: "2026-11-03", grund: "krank", entscheidung: "entschuldigt", entschiedenVon: "Jana Brandt" })]);
    expect(new TextDecoder().decode(files.get("klassenbuch.html"))).not.toMatch(/krank/);
    expect(new TextDecoder().decode(files.get("klassenbuch.json"))).not.toMatch(/"krank"/);
    expect(new TextDecoder().decode(files.get("LIESMICH.txt"))).toMatch(/Entschuldigungen.*5 Jahre/);
  });

  it("Löschlauf: Meldungen bleiben bis zur Übergabe eines Archivexports des Schuljahres", async () => {
    expect((await dueReports()).count).toBe(0);
    await confirmHandover(h.db, "u-admin", "g-7b");
    expect((await dueReports()).count).toBe(1);
    await h.db.update(recordArchives).set({ handedOverAt: null });
  });

  it("Einstellung „nein“: kein Teil im Export, Löschung zum Schuljahresende wie bisher", async () => {
    await writeModuleSetting(h.db, DIGITAL_WRITTEN, "0");
    const files = readZip((await exportClassbookArchive(h.db, "u-admin", "g-7b")).zip);
    expect([...files.keys()].sort()).toEqual(["LIESMICH.txt", "klassenbuch.html", "klassenbuch.json", "metadaten.json"]);
    expect((await dueReports()).count).toBe(1);
    await writeModuleSetting(h.db, DIGITAL_WRITTEN, "1");
  });
  it("G4D-S01: nur die Meldungen im übergebenen Export der eigenen Klasse werden frei; die übrigen zählen als zurückgehalten; Gruppenlöschung schadet nicht", async () => {
    const [other] = await h.db
      .select({ student: groupMembers.userId, groupId: groups.id })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groups.kind, "klasse"), ne(groups.id, "g-7b"), eq(groups.schoolYearId, "sj-2026-27"), eq(users.role, "schueler")))
      .limit(1);
    expect(other).toBeTruthy();
    await h.db.insert(absenceReports).values({ studentId: other!.student, fromDate: "2026-11-05", toDate: "2026-11-05", reason: "krank", status: "entschuldigt" });
    // nur die 7b übergibt ihren Export
    await exportClassbookArchive(h.db, "u-admin", "g-7b");
    await confirmHandover(h.db, "u-admin", "g-7b");
    expect((await dueReports()).count).toBe(1);
    const held = (await planDeletion(h.db, AFTER)).find((p) => p.table === "absence_reports" && p.scope === "zurückgehalten");
    expect(held).toMatchObject({ status: "skipped", count: 1 });
    expect(held!.reason).toMatch(/^1 Meldungen warten auf die Übergabe des Archivexports/);
    // die andere Klasse übergibt, danach wird ihre Gruppe gelöscht – der Vermerk an der Meldung bleibt gültig
    await exportClassbookArchive(h.db, "u-admin", other!.groupId);
    await confirmHandover(h.db, "u-admin", other!.groupId);
    await h.db.delete(groups).where(eq(groups.id, other!.groupId));
    expect((await dueReports()).count).toBe(2);
    expect((await planDeletion(h.db, AFTER)).find((p) => p.table === "absence_reports" && p.scope === "zurückgehalten")).toBeUndefined();
  });
});
