import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { bookingResources, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { saveSubstitution } from "@/modules/stundenplan/vertretung";
import { ValidationError } from "@/modules/verwaltung/users";
import { addResource, book, cancelBooking, listResources, myBookings, resourceWeek, setResourceActive } from "./service";

const MO = "2026-10-05";
const TODAY = "2026-10-03";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Buchungen", () => {
  let h: DbHandle;
  let room: string;
  let cart: string;
  let lessonId: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    await h.db.delete(bookingResources);
    const [l] = await h.db
      .insert(timetableLessons)
      .values({ groupId: "g-7b", weekday: 0, periodNr: 2, subjectId: "IF", teacherId: "u-benedikt.lange", roomId: "IF1", validFrom: "2026-08-01" })
      .returning({ id: timetableLessons.id });
    lessonId = l!.id;
  }, 60_000);
  afterAll(() => h.close());

  it("Verwaltung legt Raum und Gerät an; Lehrkräfte nicht", async () => {
    const sek = await p("u-sabine.kowalski");
    room = await addResource(h.db, sek, { kind: "room", roomId: "IF1" });
    cart = await addResource(h.db, sek, { kind: "device", name: "Laptopwagen 1", description: "16 Laptops" });
    expect((await listResources(h.db)).map((r) => r.name)).toEqual(["Informatik-Raum (IF1)", "Laptopwagen 1"]);
    await expect(addResource(h.db, sek, { kind: "room", roomId: "IF1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addResource(h.db, await p("u-jana.brandt"), { kind: "device", name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Raum: Unterricht blockiert, frei wird er durch Entfall; doppelte Buchung geht nicht", async () => {
    const jana = await p("u-jana.brandt");
    expect(await fieldErrors(book(h.db, jana, { resourceId: room, date: MO, periodNr: 2, groupId: null, note: "" }, TODAY))).toEqual({
      periodNr: "Im Raum ist Unterricht (Informatik · Klasse 7b)",
    });
    await saveSubstitution(h.db, "u-admin", { lessonId, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    await book(h.db, jana, { resourceId: room, date: MO, periodNr: 2, groupId: "g-7b", note: "Recherche" }, TODAY);
    expect(await fieldErrors(book(h.db, await p("u-tobias.kleine"), { resourceId: room, date: MO, periodNr: 2, groupId: null, note: "" }, TODAY))).toEqual({
      periodNr: "Schon gebucht von Jana Brandt",
    });
  });

  it("gebuchter Raum blockiert Raumänderungen bei Vertretungen", async () => {
    const [other] = await h.db
      .insert(timetableLessons)
      .values({ groupId: "g-9a", weekday: 0, periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201", validFrom: "2026-08-01" })
      .returning({ id: timetableLessons.id });
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: other!.id, date: MO, kind: "room", substituteId: null, roomId: "IF1", note: null }))).toEqual({
      roomId: "Raum IF1 ist zu dieser Zeit belegt",
    });
  });

  it("Woche zeigt Unterricht, Buchungen und freie Stunden; Geräte ohne Stundenplan", async () => {
    const week = await resourceWeek(h.db, room, MO);
    expect(week.get(`${MO}:2`)).toMatchObject({ kind: "booked", byName: "Jana Brandt", groupName: "Klasse 7b", note: "Recherche" });
    expect(week.get(`${MO}:1`)).toBeUndefined();
    expect(week.get("2026-10-12:2")).toBeUndefined(); // andere Woche
    const next = await resourceWeek(h.db, room, "2026-10-12");
    expect(next.get("2026-10-12:2")).toMatchObject({ kind: "lesson" });
    await book(h.db, await p("u-jana.brandt"), { resourceId: cart, date: MO, periodNr: 3, groupId: null, note: "" }, TODAY);
    expect((await resourceWeek(h.db, cart, MO)).size).toBe(1);
  });

  it("Prüfungen: Vergangenheit, Wochenende, inaktiv; stornieren nur eigene oder mit Verwaltungsrecht", async () => {
    const jana = await p("u-jana.brandt");
    expect(await fieldErrors(book(h.db, jana, { resourceId: cart, date: "2026-10-02", periodNr: 1, groupId: null, note: "" }, TODAY))).toHaveProperty("date");
    expect(await fieldErrors(book(h.db, jana, { resourceId: cart, date: "2026-10-04", periodNr: 1, groupId: null, note: "" }, TODAY))).toHaveProperty("date");
    await setResourceActive(h.db, await p("u-sabine.kowalski"), cart, false);
    expect(await fieldErrors(book(h.db, jana, { resourceId: cart, date: MO, periodNr: 5, groupId: null, note: "" }, TODAY))).toHaveProperty("resourceId");
    const mine = await myBookings(h.db, "u-jana.brandt", TODAY);
    expect(mine.map((b) => `${b.resourceName} ${b.periodNr}`)).toEqual(["Informatik-Raum (IF1) 2", "Laptopwagen 1 3"]);
    await expect(cancelBooking(h.db, await p("u-tobias.kleine"), mine[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await cancelBooking(h.db, await p("u-sabine.kowalski"), mine[0]!.id);
    await cancelBooking(h.db, jana, mine[1]!.id);
    expect(await myBookings(h.db, "u-jana.brandt", TODAY)).toEqual([]);
  });
});
