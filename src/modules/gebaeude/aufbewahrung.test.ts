// G4-01: Prüfprotokoll-PDF und Bemerkung werden geleert, sobald zwei spätere Prüfungen derselben Art am selben Ziel
// erledigt sind und die Prüfung mindestens ein Jahr zurückliegt; die Prüfung selbst bleibt als Nachweis.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { appSettings, gebaeudeInspections, gebaeudeInspectionTypes } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { localStorage, newStorageKey, type FileStorage } from "@/core/files/storage";
import { readModuleSetting, writeModuleSetting } from "@/core/modules/settings";
import { planDeletion, runDeletion } from "@/core/privacy/loeschlauf";
import { REPORT_KEEP } from "./settings";
import { ensureTemplate } from "./pruefungen";

const SCOPE = "Protokoll-PDF und Bemerkung";

describe("Aufbewahrung der Prüfprotokolle (G4-01)", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let typeId: string;
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    h = await createTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-g401-"));
    storage = localStorage(dir);
    await ensureTemplate(h.db);
    const [t] = await h.db.select({ id: gebaeudeInspectionTypes.id }).from(gebaeudeInspectionTypes).limit(1);
    typeId = t!.id;
    const add = async (name: string, building: string, doneOn: string | null, withReport = true) => {
      const key = withReport ? newStorageKey() : null;
      if (key) {
        await storage.put(key, new TextEncoder().encode("%PDF-1.4 Prüfer: Max Muster"));
        keys[name] = key;
      }
      const [row] = await h.db
        .insert(gebaeudeInspections)
        .values({ typeId, building, dueOn: doneOn ?? "2029-12-01", doneOn, result: doneOn ? "ok" : null, company: "Prüfdienst GmbH", reportKey: key, reportSize: key ? 30 : null, note: doneOn ? `Bemerkung ${name}, Herr Muster` : null })
        .returning({ id: gebaeudeInspections.id });
      ids[name] = row!.id;
    };
    // Haus A: drei erledigte Prüfungen + eine offene
    await add("a1", "Haus A", "2026-01-10");
    await add("a2", "Haus A", "2027-01-10");
    await add("a3", "Haus A", "2028-01-10");
    await add("a4", "Haus A", null, false);
    // Haus B: nur eine Prüfung – bleibt
    await add("b1", "Haus B", "2026-01-10");
    // Haus C: drei Prüfungen in kurzer Folge (z. B. nach Mängeln) – erst nach einem Jahr leeren
    await add("c1", "Haus C", "2028-02-01");
    await add("c2", "Haus C", "2028-03-01");
    await add("c3", "Haus C", "2028-04-01");
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  const row = async (name: string) => (await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.id, ids[name]!)))[0]!;

  it("leert nur Prüfungen, die zwei spätere Prüfungen am selben Ziel haben und älter als ein Jahr sind", async () => {
    const plan = await planDeletion(h.db, "2028-06-01");
    expect(plan.find((p) => p.table === "gebaeude_inspections" && p.scope === SCOPE)).toMatchObject({ status: "due", mode: "clear", count: 1 });

    const run = await runDeletion(h.db, null, "2028-06-01", { storage, now: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    expect(run.items.find((i) => i.table === "gebaeude_inspections")).toMatchObject({ scope: SCOPE, deleted: 1 });
    // a1: Protokoll und Bemerkung weg, Nachweis (Termin, Ergebnis, Firma) bleibt
    expect(await row("a1")).toMatchObject({ doneOn: "2026-01-10", result: "ok", company: "Prüfdienst GmbH", reportKey: null, reportSize: null, note: null });
    for (const n of ["a2", "a3", "b1", "c1", "c2", "c3"]) expect((await row(n)).reportKey).toBe(keys[n]);
    expect((await row("a4")).doneOn).toBeNull();
    // die PDF-Datei räumt der Dateispeicher-Lauf ab, die anderen bleiben
    const stored = new Set((await storage.list()).map((f) => f.key));
    expect(stored.has(keys.a1!)).toBe(false);
    expect(stored.has(keys.a2!)).toBe(true);
  });

  it("nach Ablauf eines Jahres auch die kurz hintereinander geprüften; ein zweiter Lauf ändert nichts mehr", async () => {
    await runDeletion(h.db, null, "2029-03-01");
    expect((await row("c1")).note).toBeNull();
    expect((await row("c2")).reportKey).toBe(keys.c2);
    expect((await row("b1")).reportKey).toBe(keys.b1);
    expect((await planDeletion(h.db, "2029-03-01")).find((p) => p.table === "gebaeude_inspections")!.count).toBe(0);
  });
});

describe("Aufbewahrung der Prüfprotokolle als Moduleinstellung (Q5-26)", () => {
  let h: DbHandle;
  let typeId: string;
  const ids: string[] = [];
  beforeAll(async () => {
    h = await createTestDb();
    await ensureTemplate(h.db);
    const [t] = await h.db.select({ id: gebaeudeInspectionTypes.id }).from(gebaeudeInspectionTypes).limit(1);
    typeId = t!.id;
    // sechs jährliche Prüfungen am selben Ziel, jede mit Bemerkung
    for (const year of [2020, 2021, 2022, 2023, 2024, 2025]) {
      const [row] = await h.db
        .insert(gebaeudeInspections)
        .values({ typeId, building: "Haus Q", dueOn: `${year}-03-01`, doneOn: `${year}-03-01`, result: "ok", company: "Prüfdienst GmbH", note: `Bemerkung ${year}` })
        .returning({ id: gebaeudeInspections.id });
      ids.push(row!.id);
    }
  }, 60_000);
  afterAll(async () => h?.close());

  const due = async (today: string) => (await planDeletion(h.db, today)).find((p) => p.table === "gebaeude_inspections" && p.scope === SCOPE)!;

  it("Vorgabe „letzte 2“, 3 und 5 wählbar; der Löschlauf liest die Einstellung, mindestens 1 Jahr bleibt", async () => {
    expect(await readModuleSetting(h.db, REPORT_KEEP)).toBe("2");
    // Vorgabe: alle außer den letzten zwei (2020–2023) – vier
    expect(await due("2026-06-01")).toMatchObject({ status: "due", mode: "clear", count: 4 });
    await writeModuleSetting(h.db, REPORT_KEEP, "3");
    expect((await due("2026-06-01")).count).toBe(3);
    await writeModuleSetting(h.db, REPORT_KEEP, "5");
    expect((await due("2026-06-01")).count).toBe(1);
    // die Jahresfrist gilt immer: am 1. 3. 2021 ist 2020 noch kein Jahr alt
    await writeModuleSetting(h.db, REPORT_KEEP, "2");
    expect((await due("2021-02-28")).count).toBe(0);
    // ungültiger gespeicherter Wert → Vorgabe
    await h.db.update(appSettings).set({ value: "1; drop table users" }).where(eq(appSettings.key, "module.gebaeude.report_keep"));
    expect(await readModuleSetting(h.db, REPORT_KEEP)).toBe("2");
    expect((await due("2026-06-01")).count).toBe(4);
    await writeModuleSetting(h.db, REPORT_KEEP, "3");
    await runDeletion(h.db, null, "2026-06-01");
    const notes = await h.db.select({ id: gebaeudeInspections.id, note: gebaeudeInspections.note }).from(gebaeudeInspections);
    expect(ids.map((id) => notes.find((n) => n.id === id)!.note)).toEqual([null, null, null, "Bemerkung 2023", "Bemerkung 2024", "Bemerkung 2025"]);
    await expect(writeModuleSetting(h.db, REPORT_KEEP, "1")).rejects.toThrow(/Ungültiger Wert/);
  });
});
