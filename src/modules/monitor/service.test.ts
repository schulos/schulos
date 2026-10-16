import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { calendarEvents, newsPosts, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { fromBerlinLocal } from "@/core/time";
import { saveSubstitution } from "@/modules/stundenplan/vertretung";
import { ValidationError } from "@/modules/verwaltung/users";
import { createScreen, deleteScreen, listScreens, monitorData, renewToken, revokeToken, screenByToken, seenAgo } from "./service";

const MO = "2026-10-05";
const NOW = fromBerlinLocal(`${MO}T07:30`);

describe("Statusmonitor", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = await createSeededTestDb();
    // Demo-Vertretungen hängen am echten Datum – für feste Erwartungen entfernen
    await h.db.delete(timetableSubstitutions);
  }, 60_000);
  afterAll(() => h.close());

  it("Token: nur Hash gespeichert, Abruf merkt „zuletzt gesehen“, erneuern und sperren", async () => {
    const { id, token } = await createScreen(h.db, "u-admin", { name: " Foyer ", location: "", profile: "foyer" });
    const row = (await listScreens(h.db)).find((s) => s.id === id)!;
    expect(row).toMatchObject({ name: "Foyer", location: null, lastSeenAt: null });
    expect(row.tokenHash).not.toContain(token);

    expect((await screenByToken(h.db, token, NOW))?.id).toBe(id);
    expect((await listScreens(h.db)).find((s) => s.id === id)!.lastSeenAt).toEqual(NOW);
    expect(await screenByToken(h.db, "x".repeat(32))).toBeNull();
    expect(await screenByToken(h.db, "../../etc")).toBeNull();

    const fresh = await renewToken(h.db, "u-admin", id);
    expect(await screenByToken(h.db, token)).toBeNull();
    expect((await screenByToken(h.db, fresh))?.id).toBe(id);
    await revokeToken(h.db, "u-admin", id);
    expect(await screenByToken(h.db, fresh)).toBeNull();
    await deleteScreen(h.db, "u-admin", id);
    await expect(createScreen(h.db, "u-admin", { name: "", location: "", profile: "aula" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Foyer: Kürzel statt Namen, keine vertretene Lehrkraft; Lehrerzimmer mit beidem", async () => {
    const [lesson] = await h.db
      .select()
      .from(timetableLessons)
      .where(and(eq(timetableLessons.groupId, "g-7b"), eq(timetableLessons.weekday, 0)));
    const [sub] = await h.db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.id, "u-tobias.kleine"));
    await saveSubstitution(h.db, "u-admin", { lessonId: lesson!.id, date: MO, kind: "substitute", substituteId: sub!.id, roomId: null, note: "Arbeitsheft S. 24" });

    const foyer = await monitorData(h.db, { profile: "foyer" }, NOW);
    expect(foyer.days.map((d) => d.date)).toEqual([MO, "2026-10-06"]);
    expect(foyer.week).toBe("A"); // KW 41
    const e = foyer.days[0]!.entries.find((x) => x.group === "7b")!;
    expect(e).toMatchObject({ kind: "substitute", substitute: sub!.code, note: "Arbeitsheft S. 24" });
    expect(e).not.toHaveProperty("absent");
    expect(JSON.stringify(foyer)).not.toContain(sub!.name);

    const staff = await monitorData(h.db, { profile: "lehrerzimmer" }, NOW);
    expect(staff.days[0]!.entries.find((x) => x.group === "7b")).toMatchObject({ substituteName: sub!.name, absent: expect.any(String) });
    // nie Namen von Schüler:innen
    const students = await h.db.select({ name: users.name }).from(users).where(eq(users.role, "schueler"));
    const json = JSON.stringify(staff);
    expect(students.some((s) => json.includes(s.name))).toBe(false);
  });

  it("Laufband: Beiträge an alle; an Lehrkräfte nur im Lehrerzimmer; Gruppen-Beiträge nie", async () => {
    await h.db.update(newsPosts).set({ onMonitor: true, publishedAt: fromBerlinLocal("2026-10-01") });
    const foyer = await monitorData(h.db, { profile: "foyer" }, NOW);
    const staff = await monitorData(h.db, { profile: "lehrerzimmer" }, NOW);
    expect(foyer.ticker).toContain("Neuer Speiseplan für die Woche ist online");
    expect(foyer.ticker).not.toContain("Herbstferien: Notbetreuung bis 9.10. anmelden"); // an Eltern + Lehrkräfte
    expect(staff.ticker).toContain("Herbstferien: Notbetreuung bis 9.10. anmelden");
    expect([...foyer.ticker, ...staff.ticker]).not.toContain("Elternabend der 7b am 13.10.");
  });

  it("Termine des Tages aus dem Schulkalender; heute frei → Grund", async () => {
    await h.db.insert(calendarEvents).values({ title: "Elternsprechtag", scope: "school", ownerId: "u-sabine.kowalski", startsAt: fromBerlinLocal(`${MO}T15:00`), endsAt: fromBerlinLocal(`${MO}T19:00`) });
    expect((await monitorData(h.db, { profile: "foyer" }, NOW)).events).toEqual([{ title: "Elternsprechtag", time: "15:00–19:00" }]);
    // 3.10.2026 ist Samstag und Feiertag: Plan zeigt Montag und Dienstag
    const sat = await monitorData(h.db, { profile: "foyer" }, fromBerlinLocal("2026-10-03T10:00"));
    expect(sat.todayOff).toBe("Feiertag (Tag der Deutschen Einheit)");
    expect(sat.days.map((d) => d.date)).toEqual([MO, "2026-10-06"]);
  });

  it("zuletzt gesehen", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    expect(seenAgo(new Date("2026-10-05T09:59:50Z"), now)).toBe("gerade eben");
    expect(seenAgo(new Date("2026-10-05T09:58:00Z"), now)).toBe("vor 2 Min.");
    expect(seenAgo(new Date("2026-10-05T07:00:00Z"), now)).toBe("vor 3 Std.");
    expect(seenAgo(new Date("2026-10-04T10:00:00Z"), now)).toBe("vor 1 Tag");
  });
});
