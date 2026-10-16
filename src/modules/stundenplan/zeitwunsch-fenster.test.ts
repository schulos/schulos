import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, timetableTimePrefSubmissions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { setModuleEnabled } from "@/core/modules/registry";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { fromBerlinLocal } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import manifest from "./manifest";
import { prefsOf, prefsWithSource, savePrefs } from "./zeitwuensche";
import { closePrefWindow, markWindow, ownSubmissionOpen, readPrefWindow, runPrefWindowReminders, saveOwnPrefs, setPrefWindow, submissions, windowState, type PrefWindow } from "./zeitwunsch-fenster";

const BUNDLE = "stundenplan:zeitwuensche";
const at = (ymd: string) => fromBerlinLocal(`${ymd}T08:00`);

describe("Zeitwünsche-Fenster (Q5-10): rein", () => {
  const w: PrefWindow = { opensOn: "2026-11-02", closesOn: "2026-11-13", schoolYearId: "x", announcedOn: null, remindedOn: null };
  it("Zustand: geplant, offen (erster und letzter Tag eingeschlossen), abgelaufen", () => {
    expect(windowState(null, "2026-11-05")).toBe("none");
    expect(windowState(w, "2026-11-01")).toBe("planned");
    expect(windowState(w, "2026-11-02")).toBe("open");
    expect(windowState(w, "2026-11-13")).toBe("open");
    expect(windowState(w, "2026-11-14")).toBe("closed");
  });
});

describe("Zeitwünsche durch Lehrkräfte selbst (Q5-10)", () => {
  let h: DbHandle;
  let teachers: string[];
  const gongs = async (userId: string) =>
    h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, BUNDLE)));

  beforeAll(async () => {
    h = await createSeededTestDb();
    teachers = (await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))).map((r) => r.id);
  }, 60_000);
  afterAll(() => h.close());

  it("ohne offenes Fenster: Lehrkraft kann nichts speichern; andere Rollen nie", async () => {
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    await expect(saveOwnPrefs(h.db, jana, new Map([["0-1", 2]]), "2026-11-03")).rejects.toBeInstanceOf(ValidationError);
    const lea = await loadPermissions(h.db, "u-lea.schaefer");
    await expect(saveOwnPrefs(h.db, lea, new Map(), "2026-11-03")).rejects.toBeInstanceOf(ForbiddenError);
    const sek = await loadPermissions(h.db, "u-sabine.kowalski");
    await expect(saveOwnPrefs(h.db, sek, new Map(), "2026-11-03")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Fenster prüfen: letzter Tag nicht in der Vergangenheit, nicht vor dem ersten", async () => {
    await expect(setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: "2026-11-02", closesOn: "2026-10-01" }, "2026-10-12")).rejects.toBeInstanceOf(ValidationError);
    await expect(setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: "2026-11-10", closesOn: "2026-11-02" }, "2026-10-12")).rejects.toBeInstanceOf(ValidationError);
    await expect(setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: "x", closesOn: "2026-11-02" }, "2026-10-12")).rejects.toBeInstanceOf(ValidationError);
    expect(await readPrefWindow(h.db)).toBeNull();
  });

  it("geplantes Fenster: noch kein Gong; der Lauf am ersten Tag kündigt allen aktiven Lehrkräften an – einmal", async () => {
    const w = await setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: "2026-11-02", closesOn: "2026-11-13" }, "2026-10-12");
    expect(w.announcedOn).toBeNull();
    expect(await gongs("u-jana.brandt")).toHaveLength(0);
    expect(await runPrefWindowReminders(h.db, at("2026-10-30"))).toBe(0);
    expect(await runPrefWindowReminders(h.db, at("2026-11-02"))).toBe(teachers.length);
    const [g] = await gongs("u-jana.brandt");
    expect(g).toMatchObject({ title: "Zeitwünsche bis 13.11.2026 abgeben", href: "/stundenplan/zeitwuensche" });
    // Schüler:innen und Verwaltung bekommen nichts
    expect(await gongs("u-lea.schaefer")).toHaveLength(0);
    expect(await gongs("u-sabine.kowalski")).toHaveLength(0);
    // zweiter Lauf am selben (oder nächsten) Tag: nichts Neues
    expect(await runPrefWindowReminders(h.db, at("2026-11-03"))).toBe(0);
    expect((await readPrefWindow(h.db))?.announcedOn).toBe("2026-11-02");
  });

  it("offenes Fenster: Lehrkraft speichert nur ihre eigenen Wünsche, Abgabe wird vermerkt (auch „alles egal“)", async () => {
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    expect(await saveOwnPrefs(h.db, jana, new Map([["0-1", null], ["4-6", -2]]), "2026-11-04")).toBe(2);
    const grid = await prefsOf(h.db, "teacher", "u-jana.brandt");
    expect(grid.get("0-1")).toBeNull();
    expect(grid.get("4-6")).toBe(-2);
    const tobias = await loadPermissions(h.db, "u-tobias.kleine");
    expect(await saveOwnPrefs(h.db, tobias, new Map([["0-1", 0]]), "2026-11-04")).toBe(0);
    const done = await submissions(h.db);
    expect([...done.keys()].sort()).toEqual(["u-jana.brandt", "u-tobias.kleine"]);
    expect((await ownSubmissionOpen(h.db, "u-jana.brandt", "2026-11-04"))?.submitted).toBe(true);
    expect((await ownSubmissionOpen(h.db, "u-jonas.richter", "2026-11-04"))?.submitted).toBe(false);
    // Janas Speichern hat Tobias' (leeres) Raster nicht angefasst und umgekehrt
    expect((await prefsOf(h.db, "teacher", "u-tobias.kleine")).size).toBe(0);
  });

  it("Planung sieht und überschreibt; die Abgabe bleibt vermerkt", async () => {
    await savePrefs(h.db, "u-sabine.kowalski", "teacher", "u-jana.brandt", new Map([["0-1", 1]]));
    expect((await prefsOf(h.db, "teacher", "u-jana.brandt")).get("0-1")).toBe(1);
    expect((await submissions(h.db)).has("u-jana.brandt")).toBe(true);
  });

  it("GATE-4f C-07: Vorgaben der Planung (auch Sperren) überschreibt die Lehrkraft nicht; sie pflegt nur ihre eigenen Wünsche", async () => {
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    // Planung: 0-1 → +1 (schon gesetzt) und Sperre 0-2 (z. B. Teilzeit-freier Vormittag)
    await savePrefs(h.db, "u-sabine.kowalski", "teacher", "u-jana.brandt", new Map([["0-1", 1], ["0-2", null]]));
    // Lehrkraft versucht beides zu ändern und ergänzt einen eigenen Wunsch: nur der eigene zählt
    expect(await saveOwnPrefs(h.db, jana, new Map([["0-1", 3], ["0-2", 2], ["3-3", -1]]), "2026-11-04")).toBe(1);
    let g = await prefsWithSource(h.db, "teacher", "u-jana.brandt");
    expect(Object.fromEntries(g)).toEqual({ "0-1": { value: 1, source: "planung" }, "0-2": { value: null, source: "planung" }, "3-3": { value: -1, source: "lehrkraft" } });
    // nochmal speichern ohne Wünsche: eigene weg, Vorgaben bleiben
    expect(await saveOwnPrefs(h.db, jana, new Map(), "2026-11-04")).toBe(0);
    expect([...(await prefsOf(h.db, "teacher", "u-jana.brandt")).keys()].sort()).toEqual(["0-1", "0-2"]);
    // Planung speichert das Raster unverändert: Wünsche der Lehrkraft bleiben ihre
    await saveOwnPrefs(h.db, jana, new Map([["3-3", -1], ["4-6", 2]]), "2026-11-04");
    await savePrefs(h.db, "u-sabine.kowalski", "teacher", "u-jana.brandt", new Map([["0-1", 1], ["0-2", null], ["3-3", -1], ["4-6", 0]]));
    g = await prefsWithSource(h.db, "teacher", "u-jana.brandt");
    expect(g.get("3-3")).toEqual({ value: -1, source: "lehrkraft" });
    // „egal“ statt des Wunsches 4-6 ist eine Vorgabe der Planung – die Lehrkraft setzt ihn nicht wieder
    expect(g.get("4-6")).toEqual({ value: 0, source: "planung" });
    await saveOwnPrefs(h.db, jana, new Map([["3-3", -1], ["4-6", 3]]), "2026-11-04");
    expect((await prefsOf(h.db, "teacher", "u-jana.brandt")).get("4-6")).toBe(0);
    // die Planung nimmt eine eigene Vorgabe zurück → der Slot ist wieder frei für die Lehrkraft
    await savePrefs(h.db, "u-sabine.kowalski", "teacher", "u-jana.brandt", new Map([["0-1", 1], ["0-2", 0], ["3-3", -1], ["4-6", 0]]));
    await saveOwnPrefs(h.db, jana, new Map([["0-2", 2], ["3-3", -1]]), "2026-11-04");
    expect(Object.fromEntries(await prefsOf(h.db, "teacher", "u-jana.brandt"))).toEqual({ "0-1": 1, "0-2": 2, "3-3": -1, "4-6": 0 });
  });

  it("GATE-4f C-08: Vermerk von Ankündigung/Erinnerung schreibt kein altes Fenster zurück", async () => {
    const before = (await readPrefWindow(h.db))!;
    // die Planung verlängert, während der Job noch die alte Momentaufnahme hat
    await setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: before.opensOn, closesOn: "2026-11-20" }, "2026-11-04");
    expect(await markWindow(h.db, before, "remindedOn", "2026-11-04")).toBe(false);
    expect(await readPrefWindow(h.db)).toMatchObject({ closesOn: "2026-11-20", remindedOn: null });
    // gleiches Fenster: nur das Feld wird gesetzt
    const now = (await readPrefWindow(h.db))!;
    expect(await markWindow(h.db, now, "remindedOn", "2026-11-04")).toBe(true);
    expect(await readPrefWindow(h.db)).toMatchObject({ closesOn: "2026-11-20", remindedOn: "2026-11-04", announcedOn: now.announcedOn });
    // zurück auf den alten Stand für die folgenden Tests
    await setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: before.opensOn, closesOn: before.closesOn }, "2026-11-04");
    await markWindow(h.db, (await readPrefWindow(h.db))!, "announcedOn", before.announcedOn!);
  });

  it("Erinnerung ab zwei Tage vor dem letzten Tag, nur an Lehrkräfte ohne Abgabe, einmal", async () => {
    expect(await runPrefWindowReminders(h.db, at("2026-11-10"))).toBe(0);
    const n = await runPrefWindowReminders(h.db, at("2026-11-11"));
    expect(n).toBe(teachers.length - 2);
    const [richter] = await gongs("u-jonas.richter");
    expect(richter?.title).toBe("Erinnerung: Zeitwünsche bis 13.11.2026 abgeben");
    expect(richter?.readAt).toBeNull();
    // Abgegeben: die Ankündigung bleibt, keine Erinnerung
    const [jana] = await gongs("u-jana.brandt");
    expect(jana?.title).toBe("Zeitwünsche bis 13.11.2026 abgeben");
    expect(await runPrefWindowReminders(h.db, at("2026-11-12"))).toBe(0);
  });

  it("nach dem letzten Tag und nach dem Schließen: Speichern abgelehnt, Wünsche bleiben", async () => {
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    await expect(saveOwnPrefs(h.db, jana, new Map(), "2026-11-14")).rejects.toBeInstanceOf(ValidationError);
    expect(await runPrefWindowReminders(h.db, at("2026-11-14"))).toBe(0);
    await closePrefWindow(h.db, "u-sabine.kowalski");
    expect(await readPrefWindow(h.db)).toBeNull();
    await expect(saveOwnPrefs(h.db, jana, new Map(), "2026-11-04")).rejects.toBeInstanceOf(ValidationError);
    expect((await prefsOf(h.db, "teacher", "u-jana.brandt")).get("0-1")).toBe(1);
    expect(await h.db.select().from(timetableTimePrefSubmissions)).toHaveLength(2);
  });

  it("Fenster ab heute: Gong sofort beim Öffnen", async () => {
    await h.db.delete(notifications).where(eq(notifications.bundleKey, BUNDLE));
    const w = await setPrefWindow(h.db, "u-sabine.kowalski", { opensOn: "2026-10-12", closesOn: "2026-10-30" }, "2026-10-12");
    expect(w.announcedOn).toBe("2026-10-12");
    expect(await gongs("u-jana.brandt")).toHaveLength(1);
    expect(await runPrefWindowReminders(h.db, at("2026-10-13"))).toBe(0);
  });

  it("Job „zeitwuensche-frist“ nur bei eingeschaltetem Modul", async () => {
    const job = SCHEDULED_JOBS.find((j) => j.name === "zeitwuensche-frist")!;
    expect(job).toBeDefined();
    await setModuleEnabled(h.db, manifest, false);
    expect(await job.run(h.db, at("2026-10-28"))).toBeUndefined();
    await setModuleEnabled(h.db, manifest, true);
    expect(await job.run(h.db, at("2026-10-28"))).toBeGreaterThan(0);
  });
});
