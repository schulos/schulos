import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/core/db/schema";
import { MODULES } from "@/modules";
import { checkRetention, collectRetention, type RetentionEntry } from "./retention";

const tables = new Map(
  (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return [cfg.name, cfg.columns.map((c) => c.name)] as const;
    }),
);

describe("Löschkonzept", () => {
  it("deckt jede Tabelle des Schemas ab", () => {
    expect(tables.size).toBeGreaterThan(20);
    expect(checkRetention(collectRetention(MODULES), tables)).toEqual([]);
  });

  it("schlägt an, wenn ein Modul seine Tabellen nicht deklariert", () => {
    const errors = checkRetention(collectRetention(MODULES.filter((m) => m.id !== "news")), tables);
    expect(errors).toEqual([
      expect.stringContaining('Tabelle "news_posts"'),
      expect.stringContaining('Tabelle "news_targets"'),
    ]);
  });

  it("meldet nicht deklarierte Tabellen, falsche Spalten und Doppelungen", () => {
    const t = new Map([
      ["a", ["id", "created_at"]],
      ["b", ["id"]],
      ["c", ["id"]],
    ]);
    const entries: RetentionEntry[] = [
      { owner: "x", decl: { table: "a", purpose: "Test", categories: ["Text"], class: "LK-1J", start: "made_at" } },
      { owner: "x", decl: { table: "a", purpose: "Test", categories: ["Text"], follows: "zzz" } },
      { owner: "y", decl: { table: "b", scope: "eins", purpose: "", categories: [], follows: "a" } },
    ];
    const errors = checkRetention(entries, t, { gibtsnicht: "x" }).join("\n");
    expect(errors).toMatch(/Spalte "made_at" fehlt/);
    expect(errors).toMatch(/a ist doppelt deklariert/);
    expect(errors).toMatch(/folgt unbekannter Tabelle "zzz"/);
    expect(errors).toMatch(/b \(eins\) braucht Zweck und Datenkategorien/);
    expect(errors).toMatch(/Tabelle "c" ist weder im Löschkonzept/);
    expect(errors).toMatch(/NO_PERSONAL_DATA nennt unbekannte Tabelle "gibtsnicht"/);
  });

  it("erlaubt mehrere Regeln je Tabelle über scope", () => {
    const t = new Map([["f", ["owner_id", "group_id"]]]);
    const entries: RetentionEntry[] = [
      { owner: "x", decl: { table: "f", scope: "privat", purpose: "P", categories: ["Datei"], class: "LK-KONTO", start: "owner_id" } },
      { owner: "x", decl: { table: "f", scope: "Gruppe", purpose: "G", categories: ["Datei"], follows: "f" } },
    ];
    expect(checkRetention(entries, t, {})).toEqual([]);
  });

  it("Spalten leeren (G4-01): nur vorhandene Spalten und nur mit Bedingung", () => {
    const t = new Map([["p", ["id", "done_on", "report_key", "note"]]]);
    const ok: RetentionEntry = { owner: "x", decl: { table: "p", scope: "PDF", purpose: "P", categories: ["PDF"], class: "LK-1J", start: "done_on", clear: ["report_key", "note"], where: "note is not null" } };
    expect(checkRetention([ok], t, {})).toEqual([]);
    const errors = checkRetention(
      [{ owner: "x", decl: { table: "p", scope: "PDF", purpose: "P", categories: ["PDF"], class: "LK-1J", start: "done_on", clear: ["gibts_nicht"] } }],
      t,
      {},
    ).join("\n");
    expect(errors).toMatch(/Spalte "gibts_nicht" fehlt/);
    expect(errors).toMatch(/Spalten leeren nur mit eigener Bedingung/);
  });

  it("einstellbare Frist (DS-15) nur für Klassen mit Tagesfrist", () => {
    const t = new Map([["p", ["id", "created_at"]]]);
    const bad: RetentionEntry = { owner: "x", decl: { table: "p", purpose: "P", categories: ["X"], class: "LK-SJ", start: "created_at", period: "x.days" } };
    expect(checkRetention([bad], t, {}).join("\n")).toMatch(/einstellbare Frist \(period\) nur für Klassen mit Tagesfrist/);
    const ok: RetentionEntry = { owner: "x", decl: { table: "p", purpose: "P", categories: ["X"], class: "LK-1J", start: "created_at", period: "x.days" } };
    expect(checkRetention([ok], t, {})).toEqual([]);
  });
});
