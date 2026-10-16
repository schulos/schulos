// Notenbuch (P5-15): Lebenszyklus – Abgang einer Lehrkraft (verwaiste Bücher, Übertragung), Löschlauf (LK-SJ-1J), Auskunft
// (lesbare Noten mit Fach/Leistung/Kommentar), Schuljahreswechsel (Bücher des Vorjahres nur lesbar, nicht übernommen).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  grants,
  groupMembers,
  groups,
  notenbuchBooks,
  notenbuchBookTeachers,
  notenbuchColumns,
  notenbuchEntries,
  notenbuchTermGrades,
  schoolYears,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import type { FileStorage } from "@/core/files/storage";
import { buildDataExport, collectPersonalData } from "@/core/privacy/auskunft";
import { runDeletion } from "@/core/privacy/loeschlauf";
import { addColumn, getBook, isPastYear, myBooks, orphanedBooks, PAST_YEAR_MESSAGE, setEntry, transferBook, transferTargets } from "./service";

const JANA = "u-jana.brandt";
const MURAT = "u-murat.yilmaz";
const PETRA = "u-petra.lindner"; // Schulleitung: transfer
const LEA = "u-lea.schaefer";
const ADMIN = "u-admin";
const SABINE = "u-sabine.kowalski"; // Verwaltung (verwaltung.privacy), ohne Notenbuch-Recht
const YEAR = "sj-2026-27";

describe("Notenbuch: Lebenszyklus (P5-15)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let bookId = "";
  let columnId = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    const [b] = await h.db
      .insert(notenbuchBooks)
      .values({ schoolYearId: YEAR, term: 1, groupId: "g-7b", subjectId: "D", scale: "noten6", weights: { schriftlich: 50, sonstige: 50 } })
      .returning({ id: notenbuchBooks.id });
    bookId = b!.id;
    await h.db.insert(notenbuchBookTeachers).values({ bookId, teacherId: JANA });
    const [c] = await h.db.insert(notenbuchColumns).values({ bookId, kind: "sonstige", title: "Referat Balladen", date: "2026-10-01" }).returning({ id: notenbuchColumns.id });
    columnId = c!.id;
    await h.db.insert(notenbuchEntries).values({ columnId, studentId: LEA, value: "2", comment: "anschaulich vorgetragen" });
    await h.db.insert(notenbuchTermGrades).values({ bookId, studentId: LEA, computed: "2" });
  }, 60_000);
  afterAll(() => h.close());

  it("Abgang einer Lehrkraft: Buch bleibt, gilt als verwaist und lässt sich übertragen", async () => {
    expect(await orphanedBooks(h.db)).toEqual([]);
    await h.db.update(users).set({ leftOn: "2026-10-10", status: "locked" }).where(eq(users.id, JANA));
    expect(await orphanedBooks(h.db)).toEqual([{ id: bookId, groupName: "Klasse 7b", subjectName: expect.any(String), schoolYearName: "2026/27", term: 1 }]);
    const petra = await p(PETRA);
    const targets = (await transferTargets(h.db, petra)).map((t) => t.id);
    expect(targets).toContain(MURAT);
    expect(targets).not.toContain(JANA);
    await expect(transferBook(h.db, petra, bookId, { toTeacherId: JANA })).rejects.toMatchObject({ fieldErrors: { toTeacherId: /aktive Lehrkraft/ } });
    await transferBook(h.db, petra, bookId, { toTeacherId: MURAT });
    expect(await orphanedBooks(h.db)).toEqual([]);
    expect((await getBook(h.db, await p(MURAT), bookId))!.entries.get(`${columnId}:${LEA}`)).toMatchObject({ value: "2" });
    // gelöschtes Konto: Eintrag geht mit (Kaskade), das Buch bleibt
    await h.db.update(users).set({ leftOn: null, status: "active" }).where(eq(users.id, JANA));
  });

  it("G5A-S01: Auskunft ohne ausdrückliches Recht der erzeugenden Person (Admin, Verwaltung mit `*`) ohne Notenbuch-Teil, mit Hinweis", async () => {
    for (const id of [ADMIN, SABINE]) {
      const actor = await p(id);
      const data = (await collectPersonalData(h.db, LEA, { actor, secondFactor: true }))!;
      expect(data.sections.filter((s) => ["noten", "halbjahresnoten", "notenbuch_entries", "notenbuch_term_grades"].includes(s.table)), id).toEqual([]);
      expect(JSON.stringify(data), id).not.toMatch(/anschaulich/);
      expect(data.withheld, id).toEqual([{ module: "notenbuch", note: expect.stringContaining("berechtigte Person") }]);
    }
    // Admin-Konto mit Gruppen-Grant `notenbuch.auskunft` (G5A-S03) zählt ebenso nicht
    await h.db.insert(grants).values({ permission: "notenbuch.auskunft", groupId: "g-schulleitung" }).onConflictDoNothing();
    await h.db.insert(groupMembers).values({ groupId: "g-schulleitung", userId: ADMIN }).onConflictDoNothing();
    expect((await collectPersonalData(h.db, LEA, { actor: await p(ADMIN), secondFactor: true }))!.withheld).toHaveLength(1);
    await h.db.delete(groupMembers).where(and(eq(groupMembers.groupId, "g-schulleitung"), eq(groupMembers.userId, ADMIN)));
    // ohne Angabe der erzeugenden Person: sicherer Standard ohne Noten
    expect((await collectPersonalData(h.db, LEA))!.withheld).toHaveLength(1);
    // berechtigt, aber Sitzung ohne zweiten Faktor: ohne Noten
    expect((await collectPersonalData(h.db, LEA, { actor: await p(PETRA), secondFactor: false }))!.withheld).toHaveLength(1);
    // ZIP: Hinweis im LIESMICH, Lesevermerk nur, wenn enthalten
    const storage = { get: async () => null } as unknown as FileStorage;
    const without = (await buildDataExport(h.db, storage, ADMIN, LEA, new Date(), { actor: await p(ADMIN), secondFactor: true }))!;
    expect(without.withheld).toEqual(["notenbuch"]);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.notenbuch.auskunft"))).toEqual([]);
    const full = (await buildDataExport(h.db, storage, PETRA, LEA, new Date(), { actor: await p(PETRA), secondFactor: true }))!;
    expect(full.withheld).toEqual([]);
    const [read] = await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.notenbuch.auskunft"));
    expect(read).toMatchObject({ actorId: PETRA, target: `auskunft:${LEA}`, meta: { modul: "notenbuch" } });
  });

  it("Auskunft: Noten der Schülerin lesbar mit Fach, Leistung und Kommentar; Lehrkraft nur ihre Bücher", async () => {
    // erteilt von einer Person mit ausdrücklichem Recht `notenbuch.auskunft` (Demo: Schulleitung)
    const lea = (await collectPersonalData(h.db, LEA, { actor: await p(PETRA), secondFactor: true }))!;
    const noten = lea.sections.find((s) => s.owner === "notenbuch" && s.table === "noten")!;
    expect(noten.rows).toEqual([
      expect.objectContaining({ schuljahr: "2026/27", halbjahr: 1, lerngruppe: "Klasse 7b", leistung: "Referat Balladen", art: "Sonstige Leistungen", note: "2", kommentar: "anschaulich vorgetragen" }),
    ]);
    expect(lea.sections.find((s) => s.owner === "notenbuch" && s.table === "halbjahresnoten")!.rows).toEqual([expect.objectContaining({ vorschlag: "2", halbjahresnote: null })]);
    const murat = (await collectPersonalData(h.db, MURAT))!;
    expect(murat.sections.find((s) => s.table === "notenbuecher")!.rows).toEqual([expect.objectContaining({ fach: expect.any(String), lerngruppe: "Klasse 7b" })]);
    expect(JSON.stringify(murat.sections.filter((s) => s.owner === "notenbuch"))).not.toMatch(/anschaulich/);
  });

  it("Löschlauf: Bücher werden ein Jahr nach Ende ihres Schuljahres samt Noten gelöscht", async () => {
    await h.db.insert(schoolYears).values({ id: "sj-2024-25", name: "2024/25", startsOn: "2024-08-01", endsOn: "2025-07-31" });
    const [old] = await h.db
      .insert(notenbuchBooks)
      .values({ schoolYearId: "sj-2024-25", term: 2, groupId: "g-7b", subjectId: "D", scale: "noten6", weights: {} })
      .returning({ id: notenbuchBooks.id });
    const [oc] = await h.db.insert(notenbuchColumns).values({ bookId: old!.id, kind: "sonstige", title: "Alt" }).returning({ id: notenbuchColumns.id });
    await h.db.insert(notenbuchEntries).values({ columnId: oc!.id, studentId: LEA, value: "3" });
    // Frist noch nicht abgelaufen (Ende 31.07.2025 + 1 Jahr)
    await runDeletion(h.db, null, "2026-07-15");
    expect(await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.id, old!.id))).toHaveLength(1);
    const run = await runDeletion(h.db, null, "2026-10-01");
    expect(run.items.find((i) => i.table === "notenbuch_books")).toMatchObject({ deleted: 1 });
    expect(await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.id, old!.id))).toHaveLength(0);
    expect(await h.db.select().from(notenbuchEntries).where(eq(notenbuchEntries.columnId, oc!.id))).toHaveLength(0);
    expect(await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId))).toHaveLength(1);
  });

  it("Schuljahreswechsel: Bücher des Vorjahres nur lesbar (auch nach Archivierung der Gruppe), nicht verwaist", async () => {
    expect(await isPastYear(h.db, YEAR)).toBe(false);
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    await h.db.update(schoolYears).set({ isCurrent: false }).where(eq(schoolYears.id, YEAR));
    await h.db.update(schoolYears).set({ isCurrent: true }).where(eq(schoolYears.id, "sj-2027-28"));
    expect(await isPastYear(h.db, YEAR)).toBe(true);
    expect(await isPastYear(h.db, "sj-2027-28")).toBe(false);
    const murat = await p(MURAT);
    await expect(setEntry(h.db, murat, { columnId, studentId: LEA, value: "1" })).rejects.toMatchObject({ fieldErrors: { value: PAST_YEAR_MESSAGE } });
    await expect(addColumn(h.db, murat, bookId, { kind: "sonstige", title: "Neu" })).rejects.toMatchObject({ fieldErrors: { book: PAST_YEAR_MESSAGE } });
    expect((await myBooks(h.db, murat)).find((b) => b.id === bookId)).toMatchObject({ pastYear: true });
    // Archivierung der Gruppe (Mitgliedschaften enden) – die Tabelle zeigt weiter alle mit Noten
    await h.db.update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, "g-7b"));
    await h.db.delete(groupMembers).where(eq(groupMembers.groupId, "g-7b"));
    const view = (await getBook(h.db, murat, bookId))!;
    expect(view.pastYear).toBe(true);
    expect(view.students.map((s) => s.id)).toEqual([LEA]);
    // vergangene Bücher gelten nicht als verwaist
    await h.db.update(users).set({ status: "locked" }).where(eq(users.id, MURAT));
    expect(await orphanedBooks(h.db)).toEqual([]);
  });
});
