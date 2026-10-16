import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DbHandle } from "@/core/db/client";
import { auditLog, fileNodes, schoolYears, timetableTimePrefs, classbookAbsences, groupMembers, parentChild, privacyDeletionRuns, sessions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage } from "@/core/files/storage";
import { ValidationError } from "@/modules/verwaltung/users";
import { accountErasureImpact, planAccountDeletion, reactivateAccount, recordTables, requestErasure, setAccountLeft } from "./konto";
import { sweepOrphanFiles } from "./dateispeicher";
import { createHold, planDeletion, runDeletion } from "./loeschlauf";

const status = async (h: DbHandle, id: string) =>
  (await h.db.select({ status: users.status, leftOn: users.leftOn }).from(users).where(eq(users.id, id)))[0];

describe("Konto-Lebenszyklus (Demo-Schule)", () => {
  let h: DbHandle;
  /** Schüler:in ohne Klassenbuch-Fehlzeiten und Elternteil mit genau diesem einen Kind */
  let student: string;
  let parent: string;
  /** Geschwister mit gemeinsamem Elternteil */
  let siblings: string[];
  let siblingParent: string;
  /** Schüler:in mit Fehlzeiten im Klassenbuch */
  let withRecord: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const absent = new Set((await h.db.selectDistinct({ id: classbookAbsences.studentId }).from(classbookAbsences)).map((r) => r.id));
    const links = await h.db.select().from(parentChild);
    const kidsOf = new Map<string, string[]>();
    const parentsOf = new Map<string, string[]>();
    for (const l of links) {
      kidsOf.set(l.parentId, [...(kidsOf.get(l.parentId) ?? []), l.childId]);
      parentsOf.set(l.childId, [...(parentsOf.get(l.childId) ?? []), l.parentId]);
    }
    const single = [...kidsOf].find(([, kids]) => kids.length === 1 && !absent.has(kids[0]!) && parentsOf.get(kids[0]!)!.length === 1)!;
    parent = single[0];
    student = single[1][0]!;
    const multi = [...kidsOf].find(([, kids]) => kids.length >= 2)!;
    [siblingParent, siblings] = multi;
    withRecord = [...absent][0]!;
  });
  afterAll(() => h.close());

  it("Akte-Tabellen: Klassenbuch und alles, was ihm folgt", () => {
    expect([...recordTables()].sort()).toEqual(["classbook_absences", "classbook_entries"]);
  });

  it("Abgang sperrt das Konto, beendet Sitzungen; Elternkonto folgt dem letzten Kind", async () => {
    await h.db.insert(sessions).values({ id: "s1", token: "t1", userId: student, expiresAt: new Date("2030-01-01") });
    await expect(setAccountLeft(h.db, "u-admin", "u-admin", "2026-10-01")).rejects.toBeInstanceOf(ValidationError);
    const res = await setAccountLeft(h.db, "u-admin", student, "2026-10-01");
    expect(res.parentsLocked).toEqual([parent]);
    expect(await status(h, student)).toEqual({ status: "locked", leftOn: "2026-10-01" });
    expect(await status(h, parent)).toEqual({ status: "locked", leftOn: "2026-10-01" });
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, student))).toEqual([]);

    // Geschwister: erst das zweite Kind nimmt das Elternkonto mit, Kontoende = letzter Abgang
    expect((await setAccountLeft(h.db, "u-admin", siblings[0]!, "2026-09-01")).parentsLocked).toEqual([]);
    expect((await status(h, siblingParent))!.status).toBe("active");
    for (const s of siblings.slice(1)) await setAccountLeft(h.db, "u-admin", s, "2026-09-15");
    expect(await status(h, siblingParent)).toEqual({ status: "locked", leftOn: "2026-09-15" });

    // Rückkehr: Kind wieder aktiv, Elternkonto kommt mit
    await reactivateAccount(h.db, "u-admin", siblings[0]!);
    expect(await status(h, siblings[0]!)).toEqual({ status: "active", leftOn: null });
    expect(await status(h, siblingParent)).toEqual({ status: "active", leftOn: null });
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.left"))).length).toBeGreaterThanOrEqual(3);
  });

  it("Löschung erst nach 90 Tagen Karenz; Akte und Löschsperre halten das Konto", async () => {
    await setAccountLeft(h.db, "u-admin", withRecord, "2026-10-01");
    const mine = [student, parent, withRecord];
    expect((await planAccountDeletion(h.db, "2026-12-29")).filter((d) => mine.includes(d.id))).toEqual([]);
    const due = await planAccountDeletion(h.db, "2026-12-30");
    expect(due.find((d) => d.id === student)).toMatchObject({ dueOn: "2026-12-30" });
    expect(due.find((d) => d.id === parent)!.blocked).toBeUndefined();
    expect(due.find((d) => d.id === student)!.blocked).toBeUndefined();
    expect(due.find((d) => d.id === withRecord)!.blocked).toMatch(/Aktenpflicht/);

    const hold = await createHold(h.db, "u-admin", { userId: parent, groupId: null, reason: "Rückfrage Schulträger", until: "2027-03-01" }, "2026-12-30");
    expect(hold).toBeTruthy();
    const plan = await planDeletion(h.db, "2026-12-30");
    const item = plan.find((p) => p.table === "users")!;
    expect(item).toMatchObject({ status: "due", scope: "Konten nach Abgang" });
    expect(plan.find((p) => p.table === "group_members")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Konto/) });

    const run = await runDeletion(h.db, "u-admin", "2026-12-30");
    expect(run.items.filter((i) => i.error)).toEqual([]);
    expect(run.items.find((i) => i.table === "users")!.deleted).toBe(item.count);
    const left = (await h.db.select({ id: users.id }).from(users).where(inArray(users.id, [student, parent, withRecord]))).map((r) => r.id);
    expect(left.sort()).toEqual([parent, withRecord].sort()); // Sperre bzw. Akte
    expect(await h.db.select().from(groupMembers).where(eq(groupMembers.userId, student))).toEqual([]);
  }, 60_000);

  it("Wirkung einer Löschung: gelöscht, ohne Namen, Akte", async () => {
    const impact = await accountErasureImpact(h.db, withRecord);
    expect(impact.find((i) => i.table === "classbook_absences")).toMatchObject({ effect: "record" });
    expect(impact.find((i) => i.table === "group_members")).toMatchObject({ effect: "deleted" });
    const teacher = await accountErasureImpact(h.db, "u-jana.brandt");
    expect(teacher.find((i) => i.table === "classbook_entries")).toMatchObject({ effect: "record" });
    expect(teacher.some((i) => i.effect === "anonymized")).toBe(true);
  });

  it("Antrag (Art. 17): sofort gelöscht, wenn nichts entgegensteht; sonst gesperrt mit Grund", async () => {
    await expect(requestErasure(h.db, "u-admin", "u-admin", "2026-10-05")).rejects.toBeInstanceOf(ValidationError);
    const [other] = await h.db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.role} = 'schueler' and ${users.status} = 'active' and ${users.id} not in (select student_id from classbook_absences)`)
      .limit(1);
    const before = (await h.db.select().from(privacyDeletionRuns)).length;
    expect(await requestErasure(h.db, "u-admin", other!.id, "2026-10-05")).toEqual({ deleted: true });
    expect(await h.db.select().from(users).where(eq(users.id, other!.id))).toEqual([]);
    expect((await h.db.select().from(privacyDeletionRuns)).length).toBe(before + 1);

    const [rec] = await h.db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.status} = 'active' and ${users.id} in (select student_id from classbook_absences)`)
      .limit(1);
    const res = await requestErasure(h.db, "u-admin", rec!.id, "2026-10-05");
    expect(res.deleted).toBe(false);
    expect(res.blocked).toMatch(/Aktenpflicht/);
    expect(await status(h, rec!.id)).toEqual({ status: "locked", leftOn: "2026-10-05" });
  });

  it("Lehrkraft-Konto löschen: Klassenbuch bleibt (blockiert), andere Verweise ohne Namen", async () => {
    // Lehrkraft ohne Klassenbuch-Einträge
    const [t] = await h.db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.role} = 'lehrkraft' and ${users.id} not in (select teacher_id from classbook_entries where teacher_id is not null)`)
      .limit(1);
    expect(t).toBeTruthy();
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).limit(1);
    await h.db.insert(timetableTimePrefs).values({ schoolYearId: year!.id, kind: "teacher", targetId: t!.id, weekday: 0, periodNr: 1, value: -2 });
    expect((await requestErasure(h.db, "u-admin", t!.id, "2026-10-05")).deleted).toBe(true);
    expect(await h.db.select().from(timetableTimePrefs).where(eq(timetableTimePrefs.targetId, t!.id))).toEqual([]);
    const res = await requestErasure(h.db, "u-admin", "u-jana.brandt", "2026-10-05");
    expect(res).toMatchObject({ deleted: false, blocked: expect.stringMatching(/Aktenpflicht/) });
  });
});

describe("Verwaiste Dateien", () => {
  let h: DbHandle;
  let dir: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-sweep-"));
  });
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("löscht nur alte Dateien ohne Datensatz", async () => {
    const storage = localStorage(dir);
    const known = { k: crypto.randomUUID() };
    await h.db.insert(fileNodes).values({ kind: "file", name: "a.txt", ownerId: "u-lea.schaefer", storageKey: known.k, size: 1, mime: "text/plain" });
    const orphanOld = crypto.randomUUID();
    const orphanNew = crypto.randomUUID();
    for (const k of [known!.k, orphanOld, orphanNew]) await storage.put(k, new Uint8Array([1]));
    const old = new Date("2026-10-01T00:00:00Z");
    for (const k of [known!.k, orphanOld]) await utimes(path.join(dir, k.slice(0, 2), k), old, old);
    const now = new Date();
    expect(await sweepOrphanFiles(h.db, storage, now)).toBe(1);
    const keys = (await storage.list()).map((f) => f.key).sort();
    expect(keys).toEqual([known!.k, orphanNew].sort());
  });
});
