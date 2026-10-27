// VT-04 (F-10-11): Sendewarteschlange der Vertretungsnachricht – Vortag 18:00, nur Endstand, Ruhezeit, „jetzt senden“, Zielgruppen,
// Kenntnisnahme-Erinnerung, Freigabe, kein Doppelversand, Kontolöschung. Die Uhr ist gefälscht (nur `Date`), Berliner Ortszeit.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, notifications, parentChild, timetableLessons, timetableNotificationQueue } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { deleteAccounts } from "@/core/privacy/konto";
import { fromBerlinLocal } from "@/core/time";
import { markerSinceDb, plannedNotifications, reschedulePending, runSubstitutionQueue, sendNow } from "./benachrichtigung";
import { NOTIFY_EVE_TIME, NOTIFY_EVE_TIME_STUDENTS, SAME_AS_TEACHERS, SUBSTITUTION_RELEASE } from "./settings";
import { acknowledgeSubstitution, deleteSubstitution, publishDay, saveSubstitution, substitutionsOn } from "./vertretung";

const ACTOR = "u-sabine.kowalski";
const at = (local: string) => fromBerlinLocal(local);
const setNow = (local: string) => vi.setSystemTime(at(local));

describe("VT-04 Vertretungsnachricht zur sinnvollen Zeit", () => {
  let h: DbHandle;
  let mother: string;
  const ids: Record<string, string> = {};
  const gongs = (userId: string, date: string) =>
    h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, `stundenplan:${date}`)));
  const pending = (date: string) =>
    h.db
      .select()
      .from(timetableNotificationQueue)
      .where(and(eq(timetableNotificationQueue.date, date), isNull(timetableNotificationQueue.sentAt)));
  const save = (key: string, date: string, over: Record<string, unknown> = {}) =>
    saveSubstitution(h.db, ACTOR, { lessonId: ids[key]!, date, kind: "cancel", substituteId: null, roomId: null, note: null, ...over });
  const remove = async (key: string, date: string) => {
    const s = (await substitutionsOn(h.db, [date])).find((x) => x.lessonId === ids[key])!;
    await deleteSubstitution(h.db, ACTOR, s.id);
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-11-09T08:00") });
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    await h.db.delete(notifications);
    const base = { validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values(
        [0, 1].flatMap((weekday) => [
          { ...base, weekday, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
          { ...base, weekday, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
          { ...base, weekday, groupId: "g-9a", periodNr: 3, subjectId: "E", teacherId: "u-sophie.wagner", roomId: "201" },
        ]),
      )
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.weekday}-${r.groupId}-${r.periodNr}`] = r.id;
    [{ mother }] = (await h.db.select({ mother: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ mother: string }];
  }, 60_000);
  afterAll(async () => {
    vi.useRealTimers();
    await h.close();
  });

  it("morgen: eingereiht für den Vortag 18:00, gesendet wird nur der Endstand (Zwischenstände nicht), genau einmal", async () => {
    const DI = "2026-11-10";
    setNow("2026-11-09T10:00");
    await save("1-g-7b-1", DI);
    expect(await gongs("u-lea.schaefer", DI)).toHaveLength(0);
    const q = await pending(DI);
    expect(q.find((r) => r.userId === "u-jana.brandt")).toMatchObject({ audience: "lehrkraefte" });
    expect(q.find((r) => r.userId === "u-lea.schaefer")).toMatchObject({ audience: "lernende" });
    expect(q.some((r) => r.userId === ACTOR)).toBe(false);
    expect(new Set(q.map((r) => r.dueAt.toISOString()))).toEqual(new Set(["2026-11-09T17:00:00.000Z"]));
    // Planung: „geplant für …“ je Tag und Zielgruppe
    const planned = await plannedNotifications(h.db);
    expect(planned.map((p) => [p.date, p.audience, p.dueAt.toISOString()])).toEqual([
      [DI, "lehrkraefte", "2026-11-09T17:00:00.000Z"],
      [DI, "lernende", "2026-11-09T17:00:00.000Z"],
    ]);

    setNow("2026-11-09T11:00");
    await save("1-g-7b-2", DI, { kind: "room", roomId: "201" });
    setNow("2026-11-09T12:00");
    await remove("1-g-7b-1", DI);
    expect((await pending(DI)).filter((r) => r.userId === "u-lea.schaefer")).toHaveLength(1);

    setNow("2026-11-09T17:59");
    expect(await runSubstitutionQueue(h.db, new Date())).toEqual({ days: 0, sent: 0 });
    setNow("2026-11-09T18:02");
    const r = await runSubstitutionQueue(h.db, new Date());
    expect(r.days).toBe(1);
    const [lea] = await gongs("u-lea.schaefer", DI);
    expect(lea).toMatchObject({ title: "Raumänderung Di., 10.11., 2. Std: Mathematik (7b)", body: "Raum 106 → 201", readAt: null });
    expect((await gongs(mother, DI))[0]?.title).toBe("Raumänderung Di., 10.11., 2. Std: Mathematik (7b)");
    expect((await gongs("u-tobias.kleine", DI))[0]?.title).toBe("Raumänderung Di., 10.11., 2. Std: Mathematik (7b)");
    // die Lehrkraft der zurückgenommenen Stunde hat nie etwas gehört – kein „keine Änderungen mehr“
    expect(await gongs("u-jana.brandt", DI)).toHaveLength(0);
    expect(JSON.stringify(await h.db.select().from(notifications))).not.toContain("Entfall");
    expect(await pending(DI)).toHaveLength(0);
    expect(await runSubstitutionQueue(h.db, new Date())).toEqual({ days: 0, sent: 0 });

    // Marker „neu/geändert“: seit dem tatsächlichen Versand des Vortags-Termins
    setNow("2026-11-10T08:00");
    expect((await markerSinceDb(h.db, new Date())).label).toBe("seit gestern, 18:02 Uhr");
  });

  it("nach der Vortags-Uhrzeit sofort; in der Ruhezeit wartet die Nachricht; „jetzt senden“ je Zielgruppe, auch nachts", async () => {
    const DI = "2026-11-10";
    setNow("2026-11-09T19:00");
    await save("1-g-7b-1", DI);
    expect((await gongs("u-lea.schaefer", DI))[0]?.title).toBe("Vertretungsplan Di., 10.11.: 1 Änderung, 1 Entfall");
    expect((await gongs("u-jana.brandt", DI))[0]?.title).toBe("Entfall Di., 10.11., 1. Std: Deutsch (7b)");

    setNow("2026-11-09T21:00");
    await remove("1-g-7b-2", DI);
    expect((await gongs("u-lea.schaefer", DI))[0]?.title).toBe("Vertretungsplan Di., 10.11.: 1 Änderung, 1 Entfall");
    expect(new Set((await pending(DI)).map((r) => r.dueAt.toISOString()))).toEqual(new Set(["2026-11-10T05:30:00.000Z"]));

    setNow("2026-11-09T21:05");
    const n = await sendNow(h.db, ACTOR, DI, "lernende");
    expect(n).toBeGreaterThan(0);
    expect((await gongs("u-lea.schaefer", DI))[0]?.title).toBe("Entfall Di., 10.11., 1. Std: Deutsch (7b)");
    expect((await gongs("u-tobias.kleine", DI))[0]?.title).toBe("Raumänderung Di., 10.11., 2. Std: Mathematik (7b)");
    expect((await pending(DI)).map((r) => r.audience)).toEqual(["lehrkraefte"]);
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.substitution.notify_now"));
    expect(log?.meta).toMatchObject({ date: DI, audience: "lernende", recipients: n });

    setNow("2026-11-10T06:29");
    expect((await runSubstitutionQueue(h.db, new Date())).sent).toBe(0);
    setNow("2026-11-10T06:30");
    expect((await runSubstitutionQueue(h.db, new Date())).sent).toBe(1);
    expect((await gongs("u-tobias.kleine", DI))[0]?.title).toBe("Vertretungsplan Di., 10.11.: keine Änderungen mehr");
  });

  it("heute: sofort – vor 06:30 erst zum Ende der Ruhezeit", async () => {
    const DI = "2026-11-10";
    setNow("2026-11-10T05:00");
    await save("1-g-9a-3", DI, { kind: "room", roomId: "110" });
    expect(await gongs("u-sophie.wagner", DI)).toHaveLength(0);
    expect((await pending(DI)).every((r) => r.dueAt.toISOString() === "2026-11-10T05:30:00.000Z")).toBe(true);
    setNow("2026-11-10T07:10");
    await save("1-g-9a-3", DI, { kind: "room", roomId: "111" });
    // die zweite Änderung schickt alles Fällige des Tages mit – im Endstand
    expect((await gongs("u-sophie.wagner", DI))[0]?.body).toBe("Raum 201 → 111");
    expect(await pending(DI)).toHaveLength(0);
  });

  it("Zielgruppen getrennt einstellbar (Vorgabe: wie Lehrkräfte); geänderte Uhrzeiten gelten auch für Eingereihtes", async () => {
    const MO = "2026-11-16";
    setNow("2026-11-13T10:00");
    await writeModuleSetting(h.db, NOTIFY_EVE_TIME_STUDENTS, "1900");
    await save("0-g-7b-1", MO);
    const due = async () => new Map((await pending(MO)).map((r) => [r.audience, r.dueAt.toISOString()]));
    expect(await due()).toEqual(
      new Map([
        ["lehrkraefte", "2026-11-15T17:00:00.000Z"],
        ["lernende", "2026-11-15T18:00:00.000Z"],
      ]),
    );
    await writeModuleSetting(h.db, NOTIFY_EVE_TIME, "1700");
    await reschedulePending(h.db);
    expect((await due()).get("lehrkraefte")).toBe("2026-11-15T16:00:00.000Z");
    expect((await due()).get("lernende")).toBe("2026-11-15T18:00:00.000Z");
    await writeModuleSetting(h.db, NOTIFY_EVE_TIME_STUDENTS, SAME_AS_TEACHERS);
    await reschedulePending(h.db);
    expect((await due()).get("lernende")).toBe("2026-11-15T16:00:00.000Z");
    await writeModuleSetting(h.db, NOTIFY_EVE_TIME, "1800");
    await reschedulePending(h.db);
    setNow("2026-11-15T18:00");
    await runSubstitutionQueue(h.db, new Date());
  });

  it("Kenntnisnahme (F-10-10): Erinnerung in der Nachricht an die Vertretungslehrkraft, bis sie bestätigt – ohne Eskalation", async () => {
    const DI = "2026-11-17";
    setNow("2026-11-16T19:00");
    const id = await save("1-g-7b-1", DI, { kind: "substitute", substituteId: "u-sophie.wagner" });
    const [g] = await gongs("u-sophie.wagner", DI);
    expect(g?.body).toContain("Bitte bestätigen: 1 Vertretung ist noch nicht als „Gesehen“ markiert.");
    expect(g?.href).toBe("/stundenplan/vertretungen#meine-vertretungen");
    // Lehrkraft der Stunde und Schüler:innen bekommen keine Erinnerung
    expect((await gongs("u-jana.brandt", DI))[0]?.body ?? "").not.toContain("bestätigen");
    expect((await gongs("u-lea.schaefer", DI))[0]?.body ?? "").not.toContain("bestätigen");
    await acknowledgeSubstitution(h.db, "u-sophie.wagner", id);
    setNow("2026-11-16T19:10");
    await save("1-g-7b-1", DI, { kind: "substitute", substituteId: "u-sophie.wagner", note: "Buch S. 12" });
    const [after] = await gongs("u-sophie.wagner", DI);
    expect(after?.body).toBe("bei Sophie Wagner · Buch S. 12");
    expect(after?.href).toBe(`/stundenplan?woche=${DI}`);
  });

  it("Freigabe: Veröffentlichen eines Entwurfstags reiht ein statt sofort zu senden", async () => {
    const MO = "2026-11-23";
    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
    setNow("2026-11-20T09:00");
    await save("0-g-7b-2", MO);
    expect(await pending(MO)).toHaveLength(0);
    const n = await publishDay(h.db, ACTOR, MO);
    expect(n).toBeGreaterThan(0);
    expect(await gongs("u-tobias.kleine", MO)).toHaveLength(0);
    expect(new Set((await pending(MO)).map((r) => r.dueAt.toISOString()))).toEqual(new Set(["2026-11-22T17:00:00.000Z"]));
    expect(await sendNow(h.db, ACTOR, MO, "lehrkraefte")).toBe(1);
    expect((await gongs("u-tobias.kleine", MO))[0]?.title).toBe("Entfall Mo., 23.11., 2. Std: Mathematik (7b)");
    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "sofort");
  });

  it("zwei Takte gleichzeitig (zwei App-Prozesse) senden nicht doppelt", async () => {
    const DI = "2026-11-24";
    setNow("2026-11-23T10:00");
    await runSubstitutionQueue(h.db, new Date()); // Liegengebliebenes anderer Tage vorher raus
    await save("1-g-9a-3", DI);
    const people = (await pending(DI)).length;
    expect(people).toBeGreaterThan(1);
    setNow("2026-11-23T18:00");
    const [a, b] = await Promise.all([runSubstitutionQueue(h.db, new Date()), runSubstitutionQueue(h.db, new Date())]);
    const messages = await h.db.select().from(notifications).where(eq(notifications.bundleKey, `stundenplan:${DI}`));
    expect(messages.length).toBeGreaterThanOrEqual(people); // mit Eltern
    expect(a.sent + b.sent).toBe(messages.length);
    expect(Math.min(a.sent, b.sent)).toBe(0);
    const rows = await h.db.select().from(timetableNotificationQueue).where(eq(timetableNotificationQueue.date, DI));
    expect(rows).toHaveLength(people);
    expect(rows.every((r) => r.sentAt !== null)).toBe(true);
  });

  it("Kontolöschung nimmt die Einträge der Person mit (Löschklasse LK-90, Fremdschlüssel)", async () => {
    const MO = "2026-11-30";
    setNow("2026-11-27T10:00");
    await save("0-g-7b-1", MO);
    expect((await pending(MO)).some((r) => r.userId === "u-lea.schaefer")).toBe(true);
    await deleteAccounts(h.db, ["u-lea.schaefer"]);
    expect(await h.db.select().from(timetableNotificationQueue).where(eq(timetableNotificationQueue.userId, "u-lea.schaefer"))).toHaveLength(0);
  });
});
