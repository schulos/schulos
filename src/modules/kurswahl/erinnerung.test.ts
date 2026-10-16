import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { autoReminderDue, missing, remindNonVoters, runKurswahlReminders } from "./erinnerung";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { auditLog, kurswahlVerfahren } from "@/core/db/schema";
import { createAngebot, createVerfahren, submitChoice, targetStudents, type VerfahrenInput } from "./service";

const TODAY = "2026-11-02";
const LEA = "u-lea.schaefer";
const SABINE = "u-sabine.kowalski";
const base: VerfahrenInput = {
  title: "WP I 7b",
  kind: "wp1",
  note: null,
  gradeLevel: 7,
  classIds: ["g-7b"],
  courseGrade: 7,
  schoolYearId: null,
  opensOn: "2026-11-01",
  closesOn: "2026-11-15",
  choices: 1,
  chooser: "eltern",
  parentConfirm: false,
};
const offer = { title: "Französisch", subjectId: "F", level: null, minSize: 0, maxSize: null, note: null, teacherId: null, hours: null };

describe("Kurswahlen – Erinnerung an Nichtwähler", () => {
  let h: DbHandle;
  const p = (u: string) => loadPermissions(h.db, u);
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Gong an die Eltern aller, die noch nicht gewählt haben – nicht an die, die gewählt haben", async () => {
    const id = await createVerfahren(h.db, await p(SABINE), base);
    const a = await createAngebot(h.db, await p(SABINE), id, offer);
    const [{ parentId: mother }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    await submitChoice(h.db, await p(mother), id, LEA, [a], TODAY);
    const m = await missing(h.db, id);
    expect(m.notChosen).toHaveLength(24);
    expect(m.notChosen).not.toContain(LEA);
    await expect(remindNonVoters(h.db, await p("u-jana.brandt"), id, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(remindNonVoters(h.db, await p(SABINE), id, "2026-11-16")).rejects.toBeInstanceOf(ValidationError);
    const n = await remindNonVoters(h.db, await p(SABINE), id, TODAY);
    const target = (await targetStudents(h.db, base)).map((s) => s.id).filter((s) => s !== LEA);
    const parents = new Set((await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(inArray(parentChild.childId, target))).map((r) => r.parentId));
    expect(n).toBe(parents.size);
    const gongs = await h.db.select().from(notifications).where(and(eq(notifications.moduleId, "kurswahl"), eq(notifications.title, "Erinnerung: WP I 7b")));
    expect(gongs.length).toBe(n);
    // Leas Mutter hat gewählt – sie bekommt nur dann eine Erinnerung, wenn sie noch ein weiteres Kind in der 7b hat
    if (!parents.has(mother)) expect(gongs.map((g) => g.userId)).not.toContain(mother);
  });

  it("Schüler:innen wählen mit Eltern-Häkchen: Kinder ohne Wahl und Eltern ohne Bestätigung werden erinnert", async () => {
    const id = await createVerfahren(h.db, await p(SABINE), { ...base, title: "Religion 7b", chooser: "schueler", parentConfirm: true });
    const a = await createAngebot(h.db, await p(SABINE), id, offer);
    await submitChoice(h.db, await p(LEA), id, LEA, [a], TODAY);
    const m = await missing(h.db, id);
    expect(m.notConfirmed).toEqual([LEA]);
    expect(m.notChosen).toHaveLength(24);
    await remindNonVoters(h.db, await p(SABINE), id, TODAY);
    const gongs = await h.db.select().from(notifications).where(and(eq(notifications.moduleId, "kurswahl"), eq(notifications.title, "Erinnerung: Religion 7b")));
    expect(gongs.filter((g) => g.body?.includes("bestätigen"))).toHaveLength(1);
    expect(gongs.map((g) => g.userId)).not.toContain(LEA);
  });

  it("P4-66: automatisch zwei Tage vor Wahlende, einmal je Verfahren; holt einen verpassten Tag nach, nicht nach dem Ende", () => {
    const v = { opensOn: "2026-11-01", closesOn: "2026-11-15", transferredAt: null, autoRemindedOn: null };
    expect(autoReminderDue(v, "2026-11-12")).toBe(false);
    expect(autoReminderDue(v, "2026-11-13")).toBe(true);
    expect(autoReminderDue(v, "2026-11-15")).toBe(true);
    expect(autoReminderDue(v, "2026-11-16")).toBe(false);
    expect(autoReminderDue({ ...v, autoRemindedOn: "2026-11-13" }, "2026-11-14")).toBe(false);
    expect(autoReminderDue({ ...v, transferredAt: new Date() }, "2026-11-13")).toBe(false);
    // kurzer Zeitraum: Wahl öffnet erst am Vortag des Endes → am ersten Tag
    expect(autoReminderDue({ ...v, opensOn: "2026-11-14" }, "2026-11-13")).toBe(false);
    expect(autoReminderDue({ ...v, opensOn: "2026-11-14" }, "2026-11-14")).toBe(true);
    expect(SCHEDULED_JOBS.find((j) => j.name === "kurswahl-erinnerung")).toMatchObject({ at: "16:00", until: "20:00" });
  });

  it("P4-66: Job erinnert Nichtwähler einmal (Gong, keine Mail); von Hand kurz vorher erinnert → keine zweite Erinnerung", async () => {
    const id = await createVerfahren(h.db, await p(SABINE), { ...base, title: "AG 7b", opensOn: "2026-11-01", closesOn: "2026-11-20" });
    await createAngebot(h.db, await p(SABINE), id, offer);
    const gongs = () => h.db.select().from(notifications).where(and(eq(notifications.moduleId, "kurswahl"), eq(notifications.title, "Erinnerung: AG 7b")));
    // drei Tage vorher: noch nichts
    expect(await runKurswahlReminders(h.db, new Date("2026-11-17T15:00:00Z"))).toBe(0);
    expect(await gongs()).toHaveLength(0);
    const n = await runKurswahlReminders(h.db, new Date("2026-11-18T15:00:00Z"));
    expect(n).toBeGreaterThan(0);
    expect(await gongs()).toHaveLength(n);
    // einmal je Verfahren
    expect(await runKurswahlReminders(h.db, new Date("2026-11-19T15:00:00Z"))).toBe(0);
    expect(await gongs()).toHaveLength(n);
    const [row] = await h.db.select().from(kurswahlVerfahren).where(eq(kurswahlVerfahren.id, id));
    expect(row!.autoRemindedOn).toBe("2026-11-18");
    const logs = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "kurswahl.remind.auto"), eq(auditLog.target, id)));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorId).toBeNull();

    // von Hand am Vormittag erinnert → der Job am Nachmittag schweigt (vermerkt aber)
    const id2 = await createVerfahren(h.db, await p(SABINE), { ...base, title: "AG 7b zwei", opensOn: "2026-11-01", closesOn: "2026-11-20" });
    await createAngebot(h.db, await p(SABINE), id2, offer);
    await remindNonVoters(h.db, await p(SABINE), id2, "2026-11-18", new Date("2026-11-18T08:00:00Z"));
    const manual = (await h.db.select().from(notifications).where(eq(notifications.title, "Erinnerung: AG 7b zwei"))).length;
    expect(await runKurswahlReminders(h.db, new Date("2026-11-18T15:00:00Z"))).toBe(0);
    expect(await h.db.select().from(notifications).where(eq(notifications.title, "Erinnerung: AG 7b zwei"))).toHaveLength(manual);
    const [row2] = await h.db.select().from(kurswahlVerfahren).where(eq(kurswahlVerfahren.id, id2));
    expect(row2!.autoRemindedOn).toBe("2026-11-18");
  });
});
