// Notenbuch (P5-16): Widget, Kursraum-Link und Suche zeigen nur eigene Bücher – keine fremden, keine Noten, kein Admin-Override.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { appSettings, notenbuchBooks, notenbuchBookTeachers, notenbuchTermGrades, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadModuleStates } from "@/core/modules/registry";
import { loadPermissions } from "@/core/permissions";
import { widgetsFor } from "@/core/widgets";
import { MODULES } from "@/modules";
import { notenbuchWidgets } from "./widgets";
import { canOwnBooks, openTermGrades, ownBookLinks } from "./links";
import { notenbuchSearch } from "./search";
import { groupStudents } from "./service";

const JANA = "u-jana.brandt"; // führt Deutsch 7b
const MURAT = "u-murat.yilmaz"; // Lehrkraft ohne eigenes Buch hier
const PETRA = "u-petra.lindner"; // Schulleitung (term_view, transfer, export)
const ADMIN = "u-admin";
const LEA = "u-lea.schaefer";
const YEAR = "sj-2026-27";

describe("Notenbuch: Verknüpfungen nur für eigene Bücher (P5-16)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let deutsch = "";
  let alt = "";
  let fremd = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.insert(schoolYears).values({ id: "sj-2025-26", name: "2025/26", startsOn: "2025-08-01", endsOn: "2026-07-31" });
    const ins = async (schoolYearId: string, groupId: string, subjectId: string, teacherId: string, term = 1) => {
      const [b] = await h.db
        .insert(notenbuchBooks)
        .values({ schoolYearId, term, groupId, subjectId, scale: "noten6", weights: { schriftlich: 50, sonstige: 50 } })
        .returning({ id: notenbuchBooks.id });
      await h.db.insert(notenbuchBookTeachers).values({ bookId: b!.id, teacherId });
      return b!.id;
    };
    deutsch = await ins(YEAR, "g-7b", "D", JANA);
    alt = await ins("sj-2025-26", "g-7b", "D", JANA, 2);
    fremd = await ins(YEAR, "g-7b", "M", MURAT);
    // Admin-Konto als Lehrkraft eingetragen: zählt trotzdem nicht (kein ausdrückliches `notenbuch.own`)
    await h.db.insert(notenbuchBookTeachers).values({ bookId: fremd, teacherId: ADMIN });
    await h.db.insert(notenbuchTermGrades).values({ bookId: deutsch, studentId: LEA, computed: "2", final: "2" });
  }, 60_000);
  afterAll(() => h.close());

  it("eigene Bücher: nur die der Lehrkraft, laufendes Schuljahr zuerst, ohne Noten", async () => {
    const jana = await p(JANA);
    const all = await ownBookLinks(h.db, jana);
    expect(all.map((b) => b.id)).toEqual([deutsch, alt]);
    expect(all[0]).toEqual({
      id: deutsch,
      groupId: "g-7b",
      groupName: "Klasse 7b",
      subjectName: expect.any(String),
      schoolYearName: "2026/27",
      term: 1,
      locked: false,
      current: true,
    });
    expect(Object.keys(all[0]!)).not.toContain("final");
    expect((await ownBookLinks(h.db, jana, { currentOnly: true })).map((b) => b.id)).toEqual([deutsch]);
    expect((await ownBookLinks(h.db, jana, { groupId: "g-7a" })).map((b) => b.id)).toEqual([]);
    expect((await ownBookLinks(h.db, await p(MURAT), { groupId: "g-7b" })).map((b) => b.id)).toEqual([fremd]);
  });

  it("Schulleitung, Admin (auch eingetragen), Verwaltung, Schüler:innen und gesperrte Konten sehen nichts", async () => {
    for (const id of [PETRA, ADMIN, "u-sabine.kowalski", LEA]) expect(await ownBookLinks(h.db, await p(id)), id).toEqual([]);
    expect(canOwnBooks(await p(ADMIN))).toBe(false);
    expect(canOwnBooks({ ...(await p(JANA)), locked: true })).toBe(false);
  });

  it("Suche: Treffer nur für eigene Bücher, nach Lerngruppe oder Fach, ohne Noten", async () => {
    const hits = await notenbuchSearch.search(h.db, { perms: await p(JANA) } as CurrentUser, "7b");
    expect(hits.map((x) => x.href)).toEqual([`/notenbuch/${deutsch}`, `/notenbuch/${alt}`]);
    expect(hits[0]).toMatchObject({ group: "Notenbücher", subtitle: "2026/27 · 1. Halbjahr" });
    expect(await notenbuchSearch.search(h.db, { perms: await p(JANA) } as CurrentUser, "Mathe")).toEqual([]);
    expect((await notenbuchSearch.search(h.db, { perms: await p(MURAT) } as CurrentUser, "Mathe")).map((x) => x.href)).toEqual([`/notenbuch/${fremd}`]);
    for (const id of [PETRA, ADMIN]) expect(await notenbuchSearch.search(h.db, { perms: await p(id) } as CurrentUser, "7b"), id).toEqual([]);
    // Platzhalter im Suchbegriff werden nicht ausgewertet
    expect(await ownBookLinks(h.db, await p(JANA), { q: "%" })).toEqual([]);
  });

  it("Widget: nur für Lehrkräfte; zählt eigene Lernende ohne festgelegte Halbjahresnote, abgeschlossen = 0", async () => {
    const states = await loadModuleStates(h.db);
    const ids = async (id: string) => widgetsFor(notenbuchWidgets, MODULES, states, await p(id)).map((w) => w.id);
    expect(await ids(JANA)).toContain("notenbuch.meine");
    for (const id of [LEA, ADMIN, "u-sabine.kowalski"]) expect(await ids(id), id).not.toContain("notenbuch.meine");
    const students = await groupStudents(h.db, "g-7b");
    const books = await ownBookLinks(h.db, await p(JANA), { currentOnly: true });
    expect((await openTermGrades(h.db, books)).get(deutsch)).toBe(students.length - 1);
    expect((await openTermGrades(h.db, [{ id: deutsch, groupId: "g-7b", locked: true }])).get(deutsch)).toBe(0);
  });
});
