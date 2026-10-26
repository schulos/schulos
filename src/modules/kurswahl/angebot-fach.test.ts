// SP2-12b: Fachfilter in der Lehrkraft-Auswahl der Kurswahl – fachfremde Zuweisung nur mit „Trotzdem zuweisen“, Server prüft, Audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableTeacherSubjects } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { setModuleEnabled } from "@/core/modules/registry";
import { loadPickList } from "@/modules/stundenplan/lehrfaecher";
import stundenplanManifest from "@/modules/stundenplan/manifest";
import { rankTeachers } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAngebot, createVerfahren, listAngebote, updateAngebot, type AngebotInput, type VerfahrenInput } from "./service";

const SABINE = "u-sabine.kowalski";
const JANA = "u-jana.brandt";
const input: VerfahrenInput = {
  title: "WP I Fachfilter",
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
const offer = (over: Partial<AngebotInput>): AngebotInput => ({ title: "Französisch", subjectId: "F", level: null, minSize: 0, maxSize: null, note: null, teacherId: null, hours: null, ...over });

describe("Kurswahl: Lehrkraft passend zum Fach (SP2-12b)", () => {
  let h: DbHandle;
  let id: string;
  const offSubjectLog = async () => (await h.db.select().from(auditLog).where(eq(auditLog.action, "kurswahl.angebot.off_subject"))).length;

  beforeAll(async () => {
    h = await createSeededTestDb();
    id = await createVerfahren(h.db, await loadPermissions(h.db, SABINE), input);
    // Jana unterrichtet laut Stammdaten nur Deutsch und Englisch, nicht Französisch
    await h.db.delete(timetableTeacherSubjects).where(eq(timetableTeacherSubjects.teacherId, JANA));
    await h.db.insert(timetableTeacherSubjects).values([
      { teacherId: JANA, subjectId: "D" },
      { teacherId: JANA, subjectId: "E" },
    ]);
  }, 60_000);
  afterAll(() => h.close());

  it("fachfremde Lehrkraft ohne Bestätigung → Fehler am Feld Lehrkraft, nichts gespeichert", async () => {
    const perms = await loadPermissions(h.db, SABINE);
    const err = await createAngebot(h.db, perms, id, offer({ teacherId: JANA })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.teacherId).toContain("unterrichtet Französisch laut Stammdaten nicht");
    expect(await listAngebote(h.db, id)).toEqual([]);
    expect(await offSubjectLog()).toBe(0);
  });

  it("mit „Trotzdem zuweisen“ wird gespeichert und protokolliert; Lehrkraft mit dem Fach braucht nichts", async () => {
    const perms = await loadPermissions(h.db, SABINE);
    await createAngebot(h.db, perms, id, offer({ teacherId: JANA, offSubjectOk: true }));
    expect(await offSubjectLog()).toBe(1);
    const row = (await h.db.select().from(auditLog).where(eq(auditLog.action, "kurswahl.angebot.off_subject")))[0]!;
    expect(row.meta).toMatchObject({ subject: "F", teachers: ["BRA"] });

    await h.db.insert(timetableTeacherSubjects).values({ teacherId: JANA, subjectId: "F" });
    await createAngebot(h.db, perms, id, offer({ title: "Französisch B", teacherId: JANA }));
    expect(await offSubjectLog()).toBe(1);
  });

  it("Ändern prüft ebenso – Fachwechsel auf ein fremdes Fach braucht die Bestätigung", async () => {
    const perms = await loadPermissions(h.db, SABINE);
    const [a] = (await listAngebote(h.db, id)).filter((x) => x.title === "Französisch B");
    await expect(updateAngebot(h.db, perms, a!.id, offer({ title: "Informatik", subjectId: "IF", teacherId: JANA }))).rejects.toBeInstanceOf(ValidationError);
    await updateAngebot(h.db, perms, a!.id, offer({ title: "Informatik", subjectId: "IF", teacherId: JANA, offSubjectOk: true }));
    expect(await offSubjectLog()).toBe(2);
    // ohne Fach oder ohne Lehrkraft gibt es nichts zu prüfen
    await updateAngebot(h.db, perms, a!.id, offer({ title: "Offen", subjectId: null, teacherId: JANA }));
    await updateAngebot(h.db, perms, a!.id, offer({ title: "Offen", subjectId: "IF", teacherId: null }));
    expect(await offSubjectLog()).toBe(2);
  });

  it("R2-P8: unveränderte Lehrkraft und unverändertes Fach – Speichern ohne erneute Bestätigung, keine doppelte Protokollzeile", async () => {
    const perms = await loadPermissions(h.db, SABINE);
    const [a] = (await listAngebote(h.db, id)).filter((x) => x.title === "Französisch");
    const before = await offSubjectLog();
    // JANA unterrichtet Französisch (wieder) nicht – das Angebot wurde damals bestätigt fachfremd angelegt
    await h.db.delete(timetableTeacherSubjects).where(and(eq(timetableTeacherSubjects.teacherId, JANA), eq(timetableTeacherSubjects.subjectId, "F")));
    try {
      await updateAngebot(h.db, perms, a!.id, offer({ title: "Französisch (neu)", teacherId: JANA, maxSize: 18 }));
      expect(await offSubjectLog()).toBe(before);
      // Fach gewechselt → wieder prüfen
      await expect(updateAngebot(h.db, perms, a!.id, offer({ title: "Informatik", subjectId: "IF", teacherId: JANA }))).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await h.db.insert(timetableTeacherSubjects).values({ teacherId: JANA, subjectId: "F" });
    }
  });

  it("R2-P7: Stundenplanmodul aus – Kurswahl-Angebot ohne Fachprüfung", async () => {
    const perms = await loadPermissions(h.db, SABINE);
    await setModuleEnabled(h.db, stundenplanManifest, false);
    try {
      const before = await offSubjectLog();
      await createAngebot(h.db, perms, id, offer({ title: "Physik AG", subjectId: "PH", teacherId: JANA }));
      expect(await offSubjectLog()).toBe(before);
    } finally {
      await setModuleEnabled(h.db, stundenplanManifest, true);
    }
  });

  it("Auswahlliste: Lehrkräfte mit dem Fach zuerst (Restdeputat, Name), andere getrennt", async () => {
    const pick = await loadPickList(h.db, "2026-11-01");
    const r = rankTeachers(pick, "F");
    expect(r.matching.map((t) => t.id)).toContain(JANA);
    const rd = rankTeachers(pick, "D");
    expect(rd.matching.every((t) => t.subjectIds.includes("D"))).toBe(true);
    expect(rd.others.concat(rd.unmaintained).some((t) => t.id === SABINE)).toBe(false);
    const rests = r.matching.map((t) => t.rest ?? 0);
    expect([...rests].sort((a, b) => b - a)).toEqual(rests);
  });
});
