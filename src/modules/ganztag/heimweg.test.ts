// GT-09/GT-10: Heimweg (nur die Art der Regel), Tagesänderung durch die Familie bis zur Frist mit Gong an die Leitung,
// „gegangen“ mit Uhrzeit, Löschung mit dem Termin bzw. dem Konto. Feste Daten (`now` wird übergeben).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { ganztagDepartures, ganztagWayHomeRules, groupMembers, notifications, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { familyView } from "./familie";
import { berlinTime, departuresOf, familyMayChange, setDayWay, setLeft, setWayRule, wayRuleList } from "./heimweg";
import { createSession, deleteSession, setListFeature, setMark } from "./service";
import { WAY_HOME_DEADLINE } from "./settings";

const SEKRETARIAT = "u-sabine.kowalski";
const RICHTER = "u-jonas.richter"; // Leitung AG Schulchor
const CHOR = "g-ag-schulchor";
const DAY = "2026-11-10"; // Dienstag
const MORNING = new Date("2026-11-10T09:30:00Z"); // 10:30 Berlin
const NOON = new Date("2026-11-10T11:30:00Z"); // 12:30 Berlin
const AFTERNOON = new Date("2026-11-10T15:05:00Z"); // 16:05 Berlin

describe("familyMayChange (rein)", () => {
  it("spätere Tage immer, am Tag selbst nur vor der Frist, vergangene nie", () => {
    expect(familyMayChange("2026-11-11", NOON, "12:00")).toBe(true);
    expect(familyMayChange(DAY, MORNING, "12:00")).toBe(true);
    expect(familyMayChange(DAY, NOON, "12:00")).toBe(false);
    expect(familyMayChange(DAY, NOON, "13:00")).toBe(true);
    expect(familyMayChange("2026-11-09", MORNING, "12:00")).toBe(false);
    expect(berlinTime(AFTERNOON)).toBe("16:05");
  });
});

describe("Ganztag GT-09/GT-10 Heimweg (DB)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let kid = "";
  let other = "";
  let parent = "";
  let session = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await setListFeature(h.db, await p(SEKRETARIAT), CHOR, true);
    const members = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .innerJoin(parentChild, eq(parentChild.childId, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, CHOR), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
      .orderBy(groupMembers.userId);
    kid = members[0]!.id;
    other = members.find((m) => m.id !== kid)!.id;
    const [link] = await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, kid));
    parent = link!.parentId;
    session = await createSession(h.db, await p(RICHTER), CHOR, { date: DAY, startsAt: "15:00", endsAt: "16:00" });
  }, 60_000);
  afterAll(async () => h?.close());

  const gongs = (title: string) => h.db.select({ userId: notifications.userId, body: notifications.body }).from(notifications).where(eq(notifications.title, title));

  it("Regel: Familie setzt die Art (Gong an die Leitung), Leitung sieht sie; Fremde nicht", async () => {
    await setWayRule(h.db, await p(parent), CHOR, kid, "abgeholt", MORNING);
    const [rule] = await h.db.select().from(ganztagWayHomeRules).where(eq(ganztagWayHomeRules.studentId, kid));
    expect(rule).toMatchObject({ groupId: CHOR, way: "abgeholt", updatedBy: parent });
    const name = (await h.db.select({ name: users.name }).from(users).where(eq(users.id, kid)))[0]!.name;
    expect(await gongs(`Heimweg geändert: ${name}`)).toEqual([expect.objectContaining({ userId: RICHTER, body: "AG Schulchor: ab jetzt wird abgeholt" })]);
    const list = (await wayRuleList(h.db, await p(RICHTER), CHOR))!;
    expect(list.find((r) => r.studentId === kid)?.way).toBe("abgeholt");
    // Eltern eines anderen Kindes bzw. die (minderjährige) Schüler:in selbst dürfen nicht
    await expect(setWayRule(h.db, await p(other), CHOR, kid, "allein")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setWayRule(h.db, await p(kid), CHOR, kid, "allein")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await wayRuleList(h.db, await p("u-jana.brandt"), CHOR)).toBeNull();
    // Leitung setzt ohne Gong an sich selbst
    await setWayRule(h.db, await p(RICHTER), CHOR, other, "bus", MORNING);
    expect((await wayRuleList(h.db, await p(RICHTER), CHOR))!.find((r) => r.studentId === other)?.way).toBe("bus");
  });

  it("eigenständige Schüler:in handelt selbst, Eltern dann nicht mehr", async () => {
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, kid));
    await expect(setWayRule(h.db, await p(parent), CHOR, kid, "allein")).rejects.toBeInstanceOf(ForbiddenError);
    await setWayRule(h.db, await p(kid), CHOR, kid, "allein", MORNING);
    await setWayRule(h.db, await p(kid), CHOR, kid, "abgeholt", MORNING);
    await h.db.update(users).set({ selfResponsible: false }).where(eq(users.id, kid));
  });

  it("Tagesänderung bis zur Frist (Vorgabe 12:00) mit Gong, danach nur die Leitung", async () => {
    await setDayWay(h.db, await p(parent), session, kid, "bus", MORNING);
    const name = (await h.db.select({ name: users.name }).from(users).where(eq(users.id, kid)))[0]!.name;
    expect(await gongs(`Heimweg heute geändert: ${name}`)).toEqual([expect.objectContaining({ userId: RICHTER, body: "AG Schulchor, 15:00 Uhr: fährt mit dem Bus" })]);
    const d = (await departuresOf(h.db, { id: session, groupId: CHOR }, [kid, other])).get(kid)!;
    expect(d).toEqual({ way: "bus", changed: true, leftAt: null });
    expect((await departuresOf(h.db, { id: session, groupId: CHOR }, [other])).get(other)).toEqual({ way: "bus", changed: false, leftAt: null });
    // nach 12:00 nicht mehr durch die Familie
    await expect(setDayWay(h.db, await p(parent), session, kid, null, NOON)).rejects.toBeInstanceOf(ValidationError);
    // Frist auf 13:00 gestellt → geht wieder; zurück auf „wie immer“
    await writeModuleSetting(h.db, WAY_HOME_DEADLINE, "13");
    await setDayWay(h.db, await p(parent), session, kid, null, NOON);
    expect((await departuresOf(h.db, { id: session, groupId: CHOR }, [kid])).get(kid)).toEqual({ way: "abgeholt", changed: false, leftAt: null });
    await writeModuleSetting(h.db, WAY_HOME_DEADLINE, "12");
    // Leitung nach der Frist am selben Tag
    await setDayWay(h.db, await p(RICHTER), session, kid, "allein", AFTERNOON);
    // am Tag danach nicht mehr
    await expect(setDayWay(h.db, await p(RICHTER), session, kid, "bus", new Date("2026-11-11T08:00:00Z"))).rejects.toBeInstanceOf(ValidationError);
    // Familienansicht zeigt Regel und Termin der nächsten Tage
    const fam = (await familyView(h.db, await p(parent), MORNING)).find((c) => c.id === kid)!;
    expect(fam.mayAct).toBe(true);
    const chor = fam.offers.find((o) => o.id === CHOR)!;
    expect(chor.way).toBe("abgeholt");
    expect(chor.days.find((x) => x.sessionId === session)).toMatchObject({ way: "allein", open: true });
  });

  it("GT-10 „gegangen“ speichert die Uhrzeit, nur Leitung, nur ab dem Termintag", async () => {
    await setMark(h.db, await p(RICHTER), session, kid, "anwesend", null, AFTERNOON);
    await expect(setLeft(h.db, await p(parent), session, kid, true, AFTERNOON)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setLeft(h.db, await p(RICHTER), session, kid, true, new Date("2026-11-09T15:00:00Z"))).rejects.toBeInstanceOf(ValidationError);
    await setLeft(h.db, await p(RICHTER), session, kid, true, AFTERNOON);
    expect((await departuresOf(h.db, { id: session, groupId: CHOR }, [kid])).get(kid)).toEqual({ way: "allein", changed: true, leftAt: "16:05" });
    await setLeft(h.db, await p(RICHTER), session, kid, false, AFTERNOON);
    expect((await departuresOf(h.db, { id: session, groupId: CHOR }, [kid])).get(kid)?.leftAt).toBeNull();
    await setLeft(h.db, await p(RICHTER), session, kid, true, AFTERNOON);
  });

  it("Tagesdaten gehen mit dem Termin", async () => {
    expect(await h.db.select().from(ganztagDepartures).where(eq(ganztagDepartures.sessionId, session))).not.toHaveLength(0);
    await deleteSession(h.db, await p(SEKRETARIAT), session);
    expect(await h.db.select().from(ganztagDepartures).where(eq(ganztagDepartures.sessionId, session))).toHaveLength(0);
  });
});
