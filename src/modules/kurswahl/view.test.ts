import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { kurswahlWahlen } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, hasPermission, loadPermissions, type PermissionSet } from "@/core/permissions";
import { remindNonVoters } from "./erinnerung";
import {
  canViewKurswahl,
  confirmChoice,
  createAngebot,
  createVerfahren,
  deleteAngebot,
  deleteVerfahren,
  getVerfahren,
  listVerfahren,
  submitChoice,
  targetStudents,
  updateAngebot,
  updateVerfahren,
  wahlRows,
  type VerfahrenInput,
} from "./service";
import { transfer, transferPreview } from "./uebernahme";
import { assignManually, explainAllocation, runAllocation, statistics } from "./zuteilen";

// SICHERHEIT SP-05 (Projektleitung 2026-10-19): `kurswahl.view` (Gruppe Stundenplanung) liest Verfahren, Angebote und Zahlen,
// darf aber nichts schreiben und sieht keine Wahlen oder Zuteilungen einzelner Schüler:innen.

const SABINE = "u-sabine.kowalski";
const FRANK = "u-frank.schulte";
const TODAY = "2026-11-20";
const input: VerfahrenInput = {
  title: "WP I Lesen",
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
const offer = { title: "Spanisch", subjectId: "F", level: null, minSize: 0, maxSize: null, note: null, teacherId: null, hours: 3 };

describe("Kurswahl lesen (`kurswahl.view`, SP-05)", () => {
  let h: DbHandle;
  let id: string;
  let angebot: string;
  let student: string;
  let frank: PermissionSet;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const sabine = await loadPermissions(h.db, SABINE);
    id = await createVerfahren(h.db, sabine, input);
    angebot = await createAngebot(h.db, sabine, id, offer);
    await createAngebot(h.db, sabine, id, { ...offer, title: "Robotik", subjectId: "IF" });
    student = (await targetStudents(h.db, input))[0]!.id;
    await h.db.insert(kurswahlWahlen).values({ verfahrenId: id, studentId: student, choices: [angebot], submittedBy: SABINE, submittedAt: new Date() });
    await runAllocation(h.db, sabine, id);
    frank = await loadPermissions(h.db, FRANK);
  }, 60_000);
  afterAll(() => h.close());

  it("Stundenplanung hat `view`, nicht `manage`; Sekretariat (manage) schließt Lesen ein; Lehrkraft ohne beides", async () => {
    expect(hasPermission(frank, "kurswahl.view")).toBe(true);
    expect(hasPermission(frank, "kurswahl.manage")).toBe(false);
    expect(canViewKurswahl(frank)).toBe(true);
    expect(canViewKurswahl(await loadPermissions(h.db, SABINE))).toBe(true);
    expect(canViewKurswahl(await loadPermissions(h.db, "u-jana.brandt"))).toBe(false);
  });

  it("liest Liste und Zahlen je Angebot", async () => {
    expect((await listVerfahren(h.db, frank)).map((v) => v.id)).toContain(id);
    const stats = await statistics(h.db, frank, (await getVerfahren(h.db, id))!);
    expect(stats.map((s) => [s.title, s.assigned])).toEqual([
      ["Spanisch", 1],
      ["Robotik", 0],
    ]);
    await expect(listVerfahren(h.db, await loadPermissions(h.db, "u-jana.brandt"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keine Personenebene: Wahlen, Zuteilungsprotokoll, Übernahme-Vorschau gesperrt", async () => {
    const v = (await getVerfahren(h.db, id))!;
    await expect(wahlRows(h.db, frank, v)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(explainAllocation(h.db, frank, v)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transferPreview(h.db, frank, v)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("schreibt nichts: Verfahren, Angebote, Wahlen, Zuteilung, Erinnerung, Übernahme", async () => {
    const attempts: [string, () => Promise<unknown>][] = [
      ["createVerfahren", () => createVerfahren(h.db, frank, input)],
      ["updateVerfahren", () => updateVerfahren(h.db, frank, id, { ...input, title: "geändert" }, TODAY)],
      ["deleteVerfahren", () => deleteVerfahren(h.db, frank, id)],
      ["createAngebot", () => createAngebot(h.db, frank, id, offer)],
      ["updateAngebot", () => updateAngebot(h.db, frank, angebot, { ...offer, title: "geändert" })],
      ["deleteAngebot", () => deleteAngebot(h.db, frank, angebot, TODAY)],
      ["submitChoice", () => submitChoice(h.db, frank, id, student, [angebot], TODAY)],
      ["confirmChoice", () => confirmChoice(h.db, frank, id, student, TODAY)],
      ["runAllocation", () => runAllocation(h.db, frank, id, { newSeed: true })],
      ["assignManually", () => assignManually(h.db, frank, id, student, null)],
      ["remindNonVoters", () => remindNonVoters(h.db, frank, id, TODAY)],
      ["transfer", () => transfer(h.db, frank, id, { acceptConflicts: true }, TODAY)],
    ];
    for (const [name, run] of attempts) await expect(run(), name).rejects.toBeInstanceOf(ForbiddenError);
    const v = (await getVerfahren(h.db, id))!;
    expect(v.title).toBe(input.title);
    expect(v.transferredAt).toBeNull();
  });
});
