import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appSettings, schoolClosures, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { deleteClosure, saveClosures } from "./closures";
import { lastHolidaySync, parseHolidays, planHolidaySync, syncHolidays, syncRange, type FetchLike } from "./ferien-abruf";

const api = (id: string, name: string, startDate: string, endDate: string) => ({ id, startDate, endDate, type: "School", name: [{ language: "DE", text: name }] });
const NRW = [
  api("h1", "Herbstferien", "2026-10-17", "2026-10-31"),
  api("w1", "Weihnachtsferien", "2026-12-23", "2027-01-06"),
  api("o1", "Osterferien", "2027-03-22", "2027-04-03"),
];

function fakeFetch(data: unknown, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => data };
  };
}

describe("Ferien automatisch (OpenHolidays API)", () => {
  it("liest die Antwort, verwirft Unbrauchbares, bevorzugt den deutschen Namen", () => {
    expect(
      parseHolidays([
        { id: "a", startDate: "2026-10-17", endDate: "2026-10-31", name: [{ language: "EN", text: "Autumn" }, { language: "DE", text: "Herbstferien" }] },
        { id: "b", startDate: "2026-10-31", endDate: "2026-10-01", name: [{ language: "DE", text: "falsch herum" }] },
        { id: "c", startDate: "2026-01-01", endDate: "2026-06-30", name: [{ language: "DE", text: "zu lang" }] },
        { startDate: "2026-01-01", endDate: "2026-01-02", name: [{ language: "DE", text: "ohne ID" }] },
      ]),
    ).toEqual([{ externalId: "a", name: "Herbstferien", startsOn: "2026-10-17", endsOn: "2026-10-31" }]);
    expect(() => parseHolidays({ error: "x" })).toThrow(/Unerwartete Antwort/);
  });

  it("Zeitraum: aktuelles und nächstes Schuljahr", () => {
    expect(syncRange("2026-10-04")).toEqual({ from: "2026-08-01", to: "2028-07-31" });
    expect(syncRange("2027-07-31")).toEqual({ from: "2026-08-01", to: "2028-07-31" });
  });

  it("Plan: Handpflege hat Vorrang, Änderungen der Quelle werden übernommen, Zurückgezogenes entfernt", () => {
    const range = { from: "2026-08-01", to: "2028-07-31" };
    const existing = [
      { id: "1", kind: "ferien", name: "Herbstferien (Schule)", startsOn: "2026-10-19", endsOn: "2026-10-30", source: null, externalId: null },
      { id: "2", kind: "ferien", name: "Weihnachtsferien", startsOn: "2026-12-22", endsOn: "2027-01-06", source: "openholidays", externalId: "w1" },
      { id: "3", kind: "ferien", name: "Alt", startsOn: "2027-02-01", endsOn: "2027-02-02", source: "openholidays", externalId: "weg" },
    ];
    const plan = planHolidaySync(existing, parseHolidays(NRW), ["x"], range);
    expect(plan.insert.map((f) => f.name)).toEqual(["Osterferien"]);
    expect(plan.update).toEqual([{ id: "2", externalId: "w1", name: "Weihnachtsferien", startsOn: "2026-12-23", endsOn: "2027-01-06" }]);
    expect(plan.remove).toEqual([{ id: "3", name: "Alt" }]);
    expect(plan.skipped).toEqual([{ name: "Herbstferien", reason: "überschneidet sich mit „Herbstferien (Schule)“ (von Hand)" }]);
  });

  it("Abgleich mit der DB: Einfügen, von Hand ändern bzw. löschen bleibt bestehen, zweiter Abruf ändert nichts", async () => {
    const h = await createTestDb();
    await h.db.insert(appSettings).values({ key: "school.state", value: "NW" });
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", username: "admin", email: "admin@schulos.local", role: "admin" });
    const calls: string[] = [];
    const s1 = await syncHolidays(h.db, "2026-10-04", fakeFetch(NRW, calls));
    expect(s1).toMatchObject({ ok: true, state: "NW", added: 3, updated: 0, removed: 0 });
    expect(calls[0]).toContain("subdivisionCode=DE-NW");
    expect(calls[0]).toContain("validFrom=2026-08-01&validTo=2028-07-31");
    const rows = await h.db.select().from(schoolClosures);
    expect(rows.every((r) => r.source === "openholidays" && r.kind === "ferien")).toBe(true);

    // von Hand: Herbstferien verlängern, Osterferien löschen
    const herbst = rows.find((r) => r.externalId === "h1")!;
    const oster = rows.find((r) => r.externalId === "o1")!;
    await saveClosures(
      h.db,
      "u-admin",
      rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, startsOn: r.startsOn, endsOn: r.id === herbst.id ? "2026-11-02" : r.endsOn })),
    );
    await deleteClosure(h.db, "u-admin", oster.id);
    const [edited] = await h.db.select().from(schoolClosures).where(eq(schoolClosures.id, herbst.id));
    expect(edited).toMatchObject({ source: null, externalId: "h1", endsOn: "2026-11-02" });
    // unveränderte Zeile bleibt automatisch
    expect((await h.db.select().from(schoolClosures).where(eq(schoolClosures.externalId, "w1")))[0]!.source).toBe("openholidays");

    const s2 = await syncHolidays(h.db, "2026-10-05", fakeFetch(NRW));
    expect(s2).toMatchObject({ ok: true, added: 0, updated: 0, removed: 0 });
    expect(s2.skipped.map((x) => x.reason).sort()).toEqual(["von Hand gelöscht", "von Hand geändert"]);
    expect((await h.db.select().from(schoolClosures).where(eq(schoolClosures.id, herbst.id)))[0]!.endsOn).toBe("2026-11-02");
    expect(await h.db.select().from(schoolClosures)).toHaveLength(2);
    await h.close();
  });

  it("offline: Fehler wird festgehalten, Ferien bleiben unverändert", async () => {
    const h = await createTestDb();
    await syncHolidays(h.db, "2026-10-04", fakeFetch(NRW));
    const failing: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND openholidaysapi.org");
    };
    const s = await syncHolidays(h.db, "2026-10-05", failing);
    expect(s).toMatchObject({ ok: false, error: "getaddrinfo ENOTFOUND openholidaysapi.org" });
    expect(await h.db.select().from(schoolClosures)).toHaveLength(3);
    expect(await lastHolidaySync(h.db)).toMatchObject({ ok: false });
    await h.close();
  });
});
