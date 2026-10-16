import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { DbHandle } from "@/core/db/client";
import * as schema from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { loadPermissions } from "@/core/permissions";
import { createLetter, letterAttachment } from "@/modules/elternbriefe/service";
import { EXPORT_FILES } from "./auskunft";
import { NOT_STORAGE_KEY_COLUMNS, registerStorageKeySource, STORAGE_KEY_COLUMNS, sweepOrphanFiles } from "./dateispeicher";
// wie im Betrieb: der nächtliche Lauf (loeschlauf.ts) bringt die Schlüsselquelle des Schullogos mit
import "./loeschlauf";

function columns() {
  const out: { table: string; column: string }[] = [];
  for (const v of Object.values(schema) as unknown[]) {
    if (!is(v, PgTable)) continue;
    const cfg = getTableConfig(v);
    for (const c of cfg.columns) out.push({ table: cfg.name, column: c.name });
  }
  return out;
}

describe("Dateispeicher: Abdeckung der Datei-Verweise (SEC-05)", () => {
  it("jede Spalte mit „key“ im Namen ist als Dateischlüssel erfasst oder begründet ausgenommen", () => {
    const all = columns();
    const listed = new Set(STORAGE_KEY_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const keyish = all.filter((c) => /key/.test(c.column)).map((c) => `${c.table}.${c.column}`);
    expect(keyish.filter((c) => !listed.has(c) && !(c in NOT_STORAGE_KEY_COLUMNS))).toEqual([]);
    // Listen bleiben echt: jeder Eintrag existiert im Schema
    const existing = new Set(all.map((c) => `${c.table}.${c.column}`));
    expect([...listed, ...Object.keys(NOT_STORAGE_KEY_COLUMNS)].filter((c) => !existing.has(c))).toEqual([]);
    expect(listed).toContain("parent_letters.attachment_key");
  });

  it("die Auskunft kennt jede Datei-Spalte (beilegen nur bei eigenen Daten)", () => {
    const inExport = new Set(EXPORT_FILES.map((f) => `${f.table}.${f.key}`));
    expect(STORAGE_KEY_COLUMNS.map((c) => `${c.table}.${c.column}`).filter((c) => !inExport.has(c))).toEqual([]);
  });
});

describe("Dateispeicher: Aufräumlauf", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-sweep-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Elternbrief-Anhang überlebt den Lauf, verwaiste Dateien gehen; weitere Schlüsselquellen werden beachtet", async () => {
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    const letterId = await createLetter(h.db, storage, jana, {
      title: "Wandertag",
      body: "Liebe Eltern",
      groupIds: ["g-7b"],
      responseType: "none",
      question: "",
      dueDate: null,
      attachment: { name: "Einverständnis.pdf", type: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) },
    });
    const orphan = crypto.randomUUID();
    await storage.put(orphan, new Uint8Array([1]));
    const extra = crypto.randomUUID();
    await storage.put(extra, new Uint8Array([2]));
    registerStorageKeySource(async () => [extra]);

    expect(await sweepOrphanFiles(h.db, storage, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    const keys = new Set((await storage.list()).map((f) => f.key));
    expect(keys.has(orphan)).toBe(false);
    expect(keys.has(extra)).toBe(true);
    const att = await letterAttachment(h.db, jana, letterId);
    expect(keys.has(att!.storageKey)).toBe(true);
    expect(await storage.get(att!.storageKey)).not.toBeNull();
  });

  it("Schullogo-Dateien aus app_settings überleben den Lauf (Anmeldung über loeschlauf.ts, P4-03)", async () => {
    const key = crypto.randomUUID();
    await storage.put(key, new Uint8Array([3]));
    const value = { key, mime: "image/png", width: 1, height: 1, bytes: 1, hash: "0123456789abcdef" };
    await h.db.insert(schema.appSettings).values({ key: "school.symbol", value });
    await sweepOrphanFiles(h.db, storage, new Date(Date.now() + 2 * 3600_000));
    expect((await storage.list()).map((f) => f.key)).toContain(key);
  });
});
