// SP2-08 (SP-G-09, SP-G-10): Dauervertretung über den Zeitraum einer Abwesenheit und Wochenblick des Vertretungsbedarfs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAbsence } from "./abwesenheit";
import { permanentMessage, savePermanentSubstitution, weekNeeds } from "./dauervertretung";
import { saveSubstitution, substitutionsOn } from "./vertretung";

const MO = "2026-10-05";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const WAG = "u-sophie.wagner";

describe("SP2-08 Dauervertretung und Wochenblick", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  let absenceId = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableLessons);
    const base = { validFrom: "2026-08-01", validUntil: null, groupId: "g-7b", subjectId: "M", teacherId: KLE, roomId: "106" };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, weekday: 0, periodNr: 2 },
        { ...base, weekday: 2, periodNr: 3 },
        { ...base, weekday: 4, periodNr: 1 },
        // WAG hat mittwochs in der 3. selbst Unterricht → dort keine Vertretung
        { ...base, weekday: 2, periodNr: 3, groupId: "g-9a", teacherId: WAG, roomId: "201" },
      ])
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday, groupId: timetableLessons.groupId });
    for (const r of rows) ids[`${r.groupId}-${r.weekday}`] = r.id;
    absenceId = await createAbsence(h.db, "u-admin", { teacherId: KLE, groupId: null, startsOn: MO, endsOn: "2026-10-16", fromPeriod: null, toPeriod: null, reason: "krank", note: null });
  }, 60_000);
  afterAll(() => h.close());

  it("Wochenblick: fünf Schultage mit offenen Stunden", async () => {
    const week = await weekNeeds(h.db, MO);
    expect(week.map((w) => [w.date, w.open])).toEqual([
      ["2026-10-05", 1],
      ["2026-10-06", 0],
      ["2026-10-07", 1],
      ["2026-10-08", 0],
      ["2026-10-09", 1],
    ]);
  });

  it("Dauervertretung: einmal festlegen – alle Tage, an denen die Vertretung kann; einzeln überschreibbar", async () => {
    const res = await savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-0"]!, from: MO, absenceId, substituteId: WAG });
    expect(res.saved).toEqual([MO, "2026-10-12"]);
    // Mittwoch: WAG unterrichtet selbst → an beiden Mittwochen übersprungen
    const wed = await savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-2"]!, from: "2026-10-07", absenceId, substituteId: WAG });
    expect(wed.saved).toEqual([]);
    expect(wed.skipped[0]!.reason).toMatch(/unterrichtet/);
    const week = await weekNeeds(h.db, MO);
    expect(week.map((w) => w.open)).toEqual([0, 0, 1, 0, 1]);
    // einzeln überschreiben: Montag BRA statt WAG
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-0"]!, date: MO, kind: "substitute", substituteId: BRA, roomId: null, note: null });
    expect((await substitutionsOn(h.db, [MO])).find((e) => e.lessonId === ids["g-7b-0"])!.substituteCode).toBe("BRA");
  });

  it("Rückmeldung nennt eingetragene und übersprungene Tage", () => {
    expect(permanentMessage({ saved: ["2026-10-05", "2026-10-12"], skipped: [{ date: "2026-10-07", reason: "Die Lehrkraft unterrichtet zu dieser Zeit selbst" }] })).toBe(
      "Dauervertretung an 2 Tagen eingetragen; nicht am 07.10. (Die Lehrkraft unterrichtet zu dieser Zeit selbst) – Betroffene sind benachrichtigt.",
    );
    expect(permanentMessage({ saved: ["2026-10-05"], skipped: [] })).toBe("Dauervertretung an 1 Tag eingetragen – Betroffene sind benachrichtigt.");
  });

  it("Prüfung: nur mit einer Abwesenheit der Lehrkraft dieser Stunde", async () => {
    await expect(savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["g-9a-2"]!, from: "2026-10-07", absenceId, substituteId: BRA })).rejects.toBeInstanceOf(ValidationError);
  });
});
