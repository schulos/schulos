import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild, timetableLessons, timetableSubstitutionDays, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { fromBerlinLocal } from "@/core/time";
import { lessonContext } from "@/modules/klassenbuch/service";
import { monitorData } from "@/modules/monitor/service";
import { ValidationError } from "@/modules/verwaltung/users";
import type { Db } from "@/core/db/client";
import { dayRelease, draftDays, isDraftDay, openDrafts, releaseMode } from "./freigabe";
import { listSlots } from "./service";
import { SUBSTITUTION_RELEASE } from "./settings";
import { deleteSubstitution, publishDay, saveSubstitution, substitutionsOn } from "./vertretung";
import { ownSubstitutions } from "./mein-deputat";

describe("Vertretungsplan Entwurf/Freigabe (Q5-11)", () => {
  let h: DbHandle;
  let mother: string;
  const MO = "2026-10-05";
  const DI = "2026-10-06";
  const MI = "2026-10-07";
  const ids: Record<string, string> = {};
  const SEK = "u-sabine.kowalski";
  const gongs = (userId: string, date: string) =>
    h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, `stundenplan:${date}`)));
  const save = (key: string, date: string, kind: "cancel" | "room" = "cancel") =>
    saveSubstitution(h.db, SEK, { lessonId: ids[key]!, date, kind, substituteId: null, roomId: kind === "room" ? "201" : null, note: kind === "room" ? "Freigabe-Test" : null });
  const foyer = async (date: string) => (await monitorData(h.db, { profile: "foyer" }, fromBerlinLocal(`${MO}T07:00`))).days.find((d) => d.date === date)!.entries;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    await h.db.delete(notifications);
    const base = { validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values(
        [0, 1, 2].flatMap((weekday) => [
          { ...base, weekday, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
          { ...base, weekday, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
        ]),
      )
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.weekday}-${r.periodNr}`] = r.id;
    [{ mother }] = (await h.db.select({ mother: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ mother: string }];
  }, 60_000);
  afterAll(() => h.close());

  it("Vorgabe „sofort“: keine Entwürfe, Gong sofort (Verhalten wie bisher)", async () => {
    expect(await releaseMode(h.db)).toBe("sofort");
    await save("2-1", MI);
    expect(await isDraftDay(h.db, MI)).toBe(false);
    expect(await gongs("u-lea.schaefer", MI)).toHaveLength(1);
  });

  it("„Freigabe“: neuer Tag wird Entwurf – kein Gong, Schüler:innen/Monitor/Kursraum sehen den Regelplan, die Planung den Entwurf", async () => {
    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
    await save("0-1", MO);
    await save("0-2", MO, "room");
    expect(await isDraftDay(h.db, MO)).toBe(true);
    expect(await dayRelease(h.db, MO)).toMatchObject({ mode: "freigabe", draft: true, publishedAt: null });
    expect(await openDrafts(h.db, "2026-10-01")).toEqual([MO]);
    for (const u of ["u-lea.schaefer", mother, "u-jana.brandt", "u-tobias.kleine"]) expect(await gongs(u, MO)).toHaveLength(0);
    // veröffentlichter Stand: nichts
    expect(await substitutionsOn(h.db, [MO])).toHaveLength(0);
    expect(await foyer(MO)).toHaveLength(0);
    const lea = await listSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, MO, DI);
    expect(lea.filter((s) => s.change)).toHaveLength(0);
    expect(await listSlots(h.db, { kind: "teacher", id: "u-jana.brandt" }, MO, DI)).toHaveLength(1);
    // Planung: Entwurf sichtbar und markiert
    const plan = await substitutionsOn(h.db, [MO], { drafts: true });
    expect(plan).toHaveLength(2);
    expect(plan.every((s) => s.draft)).toBe(true);
    expect((await listSlots(h.db, { kind: "group", id: "g-7b" }, MO, DI, { drafts: true })).filter((s) => s.change)).toHaveLength(2);
    // Klassenbuch: der Entfall gilt noch nicht; eigene Zahlen zählen ihn nicht
    await expect(lessonContext(h.db, ids["0-1"]!, MO)).resolves.toBeTruthy();
    expect((await ownSubstitutions(h.db, "u-jana.brandt", MO, MO)).cancelled).toBe(0);
    // Zurücknehmen im Entwurf meldet ebenfalls nichts
    const room = (await substitutionsOn(h.db, [MO], { drafts: true })).find((s) => s.kind === "room")!;
    await deleteSubstitution(h.db, SEK, room.id);
    expect(await gongs("u-tobias.kleine", MO)).toHaveLength(0);
    await save("0-2", MO, "room");
  });

  it("Veröffentlichen bündelt die Gongs: je Person eine Tagesnachricht, Eltern nach Einstellung, handelnde Person keine", async () => {
    const n = await publishDay(h.db, "u-petra.lindner", MO);
    expect(n).toBeGreaterThan(0);
    expect(await isDraftDay(h.db, MO)).toBe(false);
    const [lea] = await gongs("u-lea.schaefer", MO);
    expect(lea).toMatchObject({ title: "Vertretungsplan Mo., 5.10.: 1 Änderung, 1 Entfall", readAt: null });
    const [mum] = await gongs(mother, MO);
    expect(mum?.title).toBe("Vertretungsplan Mo., 5.10.: 1 Änderung, 1 Entfall");
    // Eltern ohne Notiz (S-05)
    expect(mum?.body).not.toContain("Freigabe-Test");
    expect((await gongs("u-jana.brandt", MO)).map((g) => g.title)).toEqual(["Entfall Mo., 5.10., 1. Std: Deutsch (7b)"]);
    expect(await gongs("u-tobias.kleine", MO)).toHaveLength(1);
    expect(await gongs("u-petra.lindner", MO)).toHaveLength(0);
    // jetzt für alle sichtbar
    expect(await substitutionsOn(h.db, [MO])).toHaveLength(2);
    expect((await foyer(MO)).map((e) => e.kind).sort()).toEqual(["cancel", "room"]);
    await expect(lessonContext(h.db, ids["0-1"]!, MO)).rejects.toBeInstanceOf(ValidationError);
    expect((await ownSubstitutions(h.db, "u-jana.brandt", MO, MO)).cancelled).toBe(1);
    // zweites Veröffentlichen: nichts zu tun
    expect(await publishDay(h.db, "u-petra.lindner", MO)).toBeNull();
  });

  it("nach dem Veröffentlichen gehen Einzeländerungen sofort raus (dieselbe Tagesnachricht wird ersetzt)", async () => {
    await h.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, "u-lea.schaefer"));
    const room = (await substitutionsOn(h.db, [MO])).find((s) => s.kind === "room")!;
    await deleteSubstitution(h.db, SEK, room.id);
    const g = await gongs("u-lea.schaefer", MO);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: "Entfall Mo., 5.10., 1. Std: Deutsch (7b)", readAt: null });
    expect(await isDraftDay(h.db, MO)).toBe(false);
  });

  it("Tag mit schon bekanntgegebenen Änderungen (Modus „sofort“) wird kein Entwurf", async () => {
    // MI hat aus dem ersten Test eine veröffentlichte Änderung ohne Tagesstatus
    await save("2-2", MI, "room");
    expect(await isDraftDay(h.db, MI)).toBe(false);
    expect(await substitutionsOn(h.db, [MI])).toHaveLength(2);
    expect((await gongs("u-lea.schaefer", MI))[0]?.title).toBe("Vertretungsplan Mi., 7.10.: 1 Änderung, 1 Entfall");
  });

  it("zurück auf „sofort“: ein offener Entwurf bleibt Entwurf, bis ihn jemand veröffentlicht (kein stilles Freischalten)", async () => {
    await save("1-1", DI);
    expect(await isDraftDay(h.db, DI)).toBe(true);
    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "sofort");
    await save("1-2", DI);
    expect(await draftDays(h.db, [MO, DI, MI])).toEqual(new Set([DI]));
    expect(await gongs("u-lea.schaefer", DI)).toHaveLength(0);
    expect(await publishDay(h.db, SEK, DI)).toBeGreaterThan(0);
    expect((await gongs("u-lea.schaefer", DI))[0]?.title).toBe("Vertretungsplan Di., 6.10.: 2 Stunden entfallen");
  });

  it("Entwurf ohne Änderungen veröffentlichen: kein Gong; ungültiges Datum abgelehnt", async () => {
    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
    const FR = "2026-10-09";
    await h.db.insert(timetableLessons).values({ validFrom: "2026-08-01", validUntil: null, weekday: 4, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" });
    const [fri] = await h.db.select({ id: timetableLessons.id }).from(timetableLessons).where(eq(timetableLessons.weekday, 4));
    await saveSubstitution(h.db, SEK, { lessonId: fri!.id, date: FR, kind: "cancel", substituteId: null, roomId: null, note: null });
    await h.db.delete(timetableSubstitutions).where(eq(timetableSubstitutions.date, FR));
    expect(await publishDay(h.db, SEK, FR)).toBe(0);
    expect(await gongs("u-lea.schaefer", FR)).toHaveLength(0);
    await expect(publishDay(h.db, SEK, "morgen")).rejects.toBeInstanceOf(ValidationError);
  });
  describe("GATE-4f: Gleichzeitigkeit", () => {
    const DO = "2026-10-08";
    const DO2 = "2026-10-15";
    const thu: Record<number, string> = {};
    beforeAll(async () => {
      await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
      const rows = await h.db
        .insert(timetableLessons)
        .values([
          { validFrom: "2026-08-01", validUntil: null, weekday: 3, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
          { validFrom: "2026-08-01", validUntil: null, weekday: 3, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
        ])
        .returning({ id: timetableLessons.id, periodNr: timetableLessons.periodNr });
      for (const r of rows) thu[r.periodNr] = r.id;
    });

    it("C-01: wer zwischen dem Lesen und der Tagessperre speichert, bekommt beim Veröffentlichen trotzdem den Gong", async () => {
      await saveSubstitution(h.db, SEK, { lessonId: thu[1]!, date: DO, kind: "cancel", substituteId: null, roomId: null, note: null });
      expect(await isDraftDay(h.db, DO)).toBe(true);
      // B speichert, kurz bevor A die Sperre bekommt (die Transaktion des Veröffentlichens beginnt)
      let injected = false;
      const racing = new Proxy(h.db, {
        get(target, prop, recv) {
          if (prop === "transaction")
            return async (fn: (tx: unknown) => Promise<unknown>) => {
              if (!injected) {
                injected = true;
                await saveSubstitution(h.db, SEK, { lessonId: thu[2]!, date: DO, kind: "cancel", substituteId: null, roomId: null, note: null });
              }
              return target.transaction(fn as never);
            };
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Db;
      expect(await publishDay(racing, "u-petra.lindner", DO)).toBeGreaterThan(0);
      expect(injected).toBe(true);
      expect(await gongs("u-tobias.kleine", DO)).toHaveLength(1);
      expect((await gongs("u-lea.schaefer", DO))[0]?.title).toBe("Vertretungsplan Do., 8.10.: 2 Stunden entfallen");
    });

    it("C-11: scheitert das Speichern, bleibt kein leerer Entwurf zurück", async () => {
      const failing = new Proxy(h.db, {
        get(target, prop, recv) {
          if (prop === "transaction")
            return (fn: (tx: unknown) => Promise<unknown>) =>
              target.transaction(async (tx) => {
                await fn(tx);
                throw new Error("DB weg");
              });
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Db;
      await expect(saveSubstitution(failing, SEK, { lessonId: thu[1]!, date: DO2, kind: "cancel", substituteId: null, roomId: null, note: null })).rejects.toThrow("DB weg");
      expect(await h.db.select().from(timetableSubstitutionDays).where(eq(timetableSubstitutionDays.date, DO2))).toHaveLength(0);
      expect(await openDrafts(h.db, DO2)).toEqual([]);
    });
  });
});
