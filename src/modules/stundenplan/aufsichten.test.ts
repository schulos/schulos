import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAbsence } from "./abwesenheit";
import { eq, like } from "drizzle-orm";
import { notifications, users } from "@/core/db/schema";
import {
  absentForBreak,
  addDuty,
  breaksFrom,
  clearDutyChange,
  createArea,
  dutiesOn,
  dutyCandidates,
  dutyLabel,
  dutyPlan,
  listAreas,
  myDutiesBetween,
  myDutyWeek,
  schoolBreaks,
  setDutyChange,
} from "./aufsichten";

describe("breaksFrom / absentForBreak", () => {
  it("Pausen ab 10 Minuten, längste heißt große Pause", () => {
    const b = breaksFrom([
      { nr: 1, startsAt: "08:00", endsAt: "08:45" },
      { nr: 2, startsAt: "08:50", endsAt: "09:35" },
      { nr: 3, startsAt: "09:55", endsAt: "10:40" },
      { nr: 4, startsAt: "10:45", endsAt: "11:30" },
      { nr: 5, startsAt: "11:45", endsAt: "12:30" },
    ]);
    expect(b.map((x) => `${x.afterPeriod} ${x.startsAt}-${x.endsAt} ${x.label}`)).toEqual(["2 09:35-09:55 1. Pause (große)", "4 11:30-11:45 2. Pause"]);
  });

  it("abwesend in der Stunde davor oder danach zählt", () => {
    const a = { id: "x", teacherId: "t", groupId: null, label: "T", startsOn: "2026-10-05", endsOn: "2026-10-05", fromPeriod: 3, toPeriod: 4, reason: "fortbildung" as const, note: null };
    expect(absentForBreak([a], "t", "2026-10-05", 2)).not.toBeNull(); // Pause nach der 2. – 3. Stunde fehlt
    expect(absentForBreak([a], "t", "2026-10-05", 4)).not.toBeNull();
    expect(absentForBreak([a], "t", "2026-10-05", 5)).toBeNull();
  });
});

describe("Pausenaufsichten (Demo-Schule)", () => {
  let h: DbHandle;
  const MO = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Seed: drei Bereiche, je Pause und Tag eine Aufsicht je Bereich", async () => {
    const [areas, breaks, plan] = await Promise.all([listAreas(h.db), schoolBreaks(h.db), dutyPlan(h.db)]);
    expect(areas.map((a) => a.name)).toEqual(["Schulhof", "Pausenhalle", "Mensa"]);
    expect(breaks.length).toBeGreaterThan(0);
    expect(plan.length).toBe(5 * breaks.length * 3);
    expect((await dutiesOn(h.db, MO)).every((d) => d.status === "regular")).toBe(true);
    expect(await dutiesOn(h.db, "2026-10-04")).toEqual([]); // Sonntag
  });

  it("prüft Eingaben", async () => {
    const [area] = await listAreas(h.db);
    const [first] = await dutyPlan(h.db);
    await expect(createArea(h.db, "u-admin", "schulhof")).rejects.toBeInstanceOf(ValidationError);
    await expect(addDuty(h.db, "u-admin", { areaId: area!.id, weekday: 0, afterPeriod: 1, teacherId: "u-jana.brandt" })).rejects.toBeInstanceOf(ValidationError); // keine Pause nach der 1.
    const dup = first!;
    const fe = (p: Promise<unknown>) => p.then(() => ({}) as Record<string, string>, (e: unknown) => (e instanceof ValidationError ? e.fieldErrors : Promise.reject(e)));
    expect((await fe(addDuty(h.db, "u-admin", { areaId: dup.areaId, weekday: dup.weekday, afterPeriod: dup.afterPeriod, teacherId: dup.teacherId }))).teacherId).toMatch(/schon eingeteilt/);
    const id = await createArea(h.db, "u-admin", "Bushaltestelle");
    expect((await fe(addDuty(h.db, "u-admin", { areaId: id, weekday: dup.weekday, afterPeriod: dup.afterPeriod, teacherId: dup.teacherId }))).teacherId).toMatch(/schon eine Aufsicht/);
  });

  it("Lehrkraft fehlt → Aufsicht offen; Vertretung nur durch freie Lehrkräfte, im Haus zuerst; entfällt bewusst; aufheben", async () => {
    const duty = (await dutiesOn(h.db, MO))[0]!;
    await createAbsence(h.db, "u-admin", { teacherId: duty.teacherId, groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    let day = await dutiesOn(h.db, MO);
    expect(day.find((d) => d.id === duty.id)!.status).toBe("open");

    const cands = await dutyCandidates(h.db, duty.id, MO);
    expect(cands.some((c) => c.id === duty.teacherId)).toBe(false);
    const others = day.filter((d) => d.afterPeriod === duty.afterPeriod).map((d) => d.teacherId);
    expect(cands.some((c) => others.includes(c.id))).toBe(false);
    const firstOut = cands.findIndex((c) => !c.inHouse);
    if (firstOut > 0) expect(cands.slice(0, firstOut).every((c) => c.inHouse)).toBe(true);

    await expect(setDutyChange(h.db, "u-admin", duty.id, MO, others.find((o) => o !== duty.teacherId)!)).rejects.toBeInstanceOf(ValidationError);
    await setDutyChange(h.db, "u-admin", duty.id, MO, cands[0]!.id);
    day = await dutiesOn(h.db, MO);
    const covered = day.find((d) => d.id === duty.id)!;
    expect(covered).toMatchObject({ status: "covered", change: { substituteId: cands[0]!.id } });
    // wer vertritt, ist in dieser Pause nicht mehr frei
    const other = day.find((d) => d.afterPeriod === duty.afterPeriod && d.id !== duty.id)!;
    expect((await dutyCandidates(h.db, other.id, MO)).some((c) => c.id === cands[0]!.id)).toBe(false);

    await setDutyChange(h.db, "u-admin", duty.id, MO, null);
    expect((await dutiesOn(h.db, MO)).find((d) => d.id === duty.id)!.status).toBe("dropped");
    await clearDutyChange(h.db, "u-admin", (await dutiesOn(h.db, MO)).find((d) => d.id === duty.id)!.change!.id);
    expect((await dutiesOn(h.db, MO)).find((d) => d.id === duty.id)!.status).toBe("open");
  });

  it("Q5-09: Gong an Vertretende und Vertretene (gebündelt je Aufsicht und Tag), handelnde Person nie", async () => {
    const DI = "2026-10-06";
    const duty = (await dutiesOn(h.db, DI))[0]!;
    await h.db.delete(notifications);
    const cands = await dutyCandidates(h.db, duty.id, DI);
    const [a, b] = [cands[0]!.id, cands[1]!.id];
    const gongs = async () =>
      (await h.db.select().from(notifications).where(like(notifications.bundleKey, `aufsicht:${duty.id}:%`))).map((n) => [n.userId, n.title]).sort((x, y) => x[0]!.localeCompare(y[0]!));
    await setDutyChange(h.db, "u-admin", duty.id, DI, a);
    const [sub] = await h.db.select({ code: users.shortCode }).from(users).where(eq(users.id, a));
    expect(await gongs()).toEqual(
      [
        [a, `Aufsicht übernehmen: ${dutyLabel(duty, DI)}`],
        [duty.teacherId, `Deine Aufsicht ${dutyLabel(duty, DI)} übernimmt ${sub!.code}`],
      ].sort((x, y) => x[0]!.localeCompare(y[0]!)),
    );
    // Wechsel a → b: a bekommt „zurückgenommen“, b „übernehmen“, die Lehrkraft eine (ersetzte) Nachricht
    await setDutyChange(h.db, "u-admin", duty.id, DI, b);
    const after = await gongs();
    expect(after).toHaveLength(3);
    expect(after.find((g) => g[0] === a)![1]).toMatch(/zurückgenommen/);
    expect(after.find((g) => g[0] === b)![1]).toMatch(/^Aufsicht übernehmen/);
    // zurücknehmen durch die Vertretung selbst: sie bekommt nichts, die Lehrkraft „gilt wieder“
    await clearDutyChange(h.db, b, (await dutiesOn(h.db, DI)).find((d) => d.id === duty.id)!.change!.id);
    const cleared = await gongs();
    expect(cleared.find((g) => g[0] === duty.teacherId)![1]).toMatch(/gilt wieder$/);
    expect(cleared.find((g) => g[0] === b)![1]).toMatch(/^Aufsicht übernehmen/); // unverändert, kein neuer Gong an sich selbst
  });

  it("Q5-09: meine Aufsichten – eigene ohne Vertretung, übernommene als „covering“; Regelplan je Wochentag", async () => {
    const MI = "2026-10-07";
    const [duty, other] = (await dutiesOn(h.db, MI)).filter((d, i, all) => all.findIndex((x) => x.teacherId === d.teacherId) === i);
    const before = await myDutiesBetween(h.db, duty!.teacherId, MI, "2026-10-08");
    expect(before.map((d) => d.dutyId)).toContain(duty!.id);
    expect(before.every((d) => d.kind === "regular" && d.date === MI)).toBe(true);
    const cand = (await dutyCandidates(h.db, duty!.id, MI)).find((c) => c.id !== other!.teacherId)!;
    await setDutyChange(h.db, "u-admin", duty!.id, MI, cand.id);
    expect((await myDutiesBetween(h.db, duty!.teacherId, MI, "2026-10-08")).map((d) => d.dutyId)).not.toContain(duty!.id);
    expect((await myDutiesBetween(h.db, cand.id, MI, "2026-10-08")).find((d) => d.dutyId === duty!.id)).toMatchObject({ kind: "covering" });
    // Wochenende liefert nichts
    expect(await myDutiesBetween(h.db, duty!.teacherId, "2026-10-10", "2026-10-12")).toEqual([]);
    const week = await myDutyWeek(h.db, duty!.teacherId);
    expect(week.length).toBe((await dutyPlan(h.db)).filter((d) => d.teacherId === duty!.teacherId).length);
    expect(week.every((w, i) => i === 0 || week[i - 1]!.weekday <= w.weekday)).toBe(true);
  });
});
