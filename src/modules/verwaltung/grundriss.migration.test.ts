// RS-13: Update einer Bestandsinstallation – die Migration ergänzt `building_floors` um den Grundriss und `rooms` um den Punkt.
// Die In-Memory-DB wird zunächst nur bis zur Migration davor migriert (Journal gekürzt), mit Gebäude, Etage und Räumen gefüllt
// und dann vollständig: Bestand bleibt unverändert, alles ohne Plan/Punkt, die Prüfungen greifen.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { listBuildings } from "./gebaeude-etagen";
import { roomDirectory } from "./raumsteckbrief";

const TAG = /^\d{4}_rs_13_grundriss$/;

describe("Migration RS-13 (Grundriss je Etage) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex((e) => TAG.test(e.tag));
    expect(at).toBeGreaterThan(0);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Bestand bleibt gleich, kein Plan, kein Punkt; Prüfungen gegen halbe Angaben", async () => {
    await h.db.execute(sql`insert into buildings (id, name, sort_order) values ('b1', 'Hauptgebäude', 10)`);
    await h.db.execute(sql`insert into building_floors (id, building_id, name, sort_order) values ('f1', 'b1', 'EG', 10)`);
    for (const id of ["101", "102"])
      await h.db.execute(sql`insert into rooms (id, name, kind, building, floor, building_id, floor_id, accessible, active) values (${id}, ${`Raum ${id}`}, 'klassenraum', 'Hauptgebäude', 'EG', 'b1', 'f1', false, true)`);
    const before = rowsOf<Record<string, unknown>>(await h.db.execute(sql`select id, name, building, floor, building_id, floor_id from rooms order by id`));

    await h.migrate();

    const floors = rowsOf<Record<string, unknown>>(await h.db.execute(sql`select * from building_floors`));
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({ name: "EG", plan_key: null, plan_thumb_key: null, plan_alt: null, plan_width: null, plan_updated_at: null });
    const rs = rowsOf<Record<string, unknown>>(await h.db.execute(sql`select id, plan_x, plan_y from rooms order by id`));
    expect(rs).toEqual([
      { id: "101", plan_x: null, plan_y: null },
      { id: "102", plan_x: null, plan_y: null },
    ]);
    expect(rowsOf(await h.db.execute(sql`select id, name, building, floor, building_id, floor_id from rooms order by id`))).toEqual(before);
    expect((await roomDirectory(h.db)).map((r) => [r.id, r.building, r.floor])).toEqual(before.map((r) => [r.id, r.building, r.floor]));
    expect((await listBuildings(h.db))[0]!.floors.map((f) => f.rooms)).toEqual([2]);

    // Punkt: beide oder keiner, 0–1
    await expect(h.db.execute(sql`update rooms set plan_x = 0.5 where id = '101'`)).rejects.toThrow();
    await expect(h.db.execute(sql`update rooms set plan_x = 1.5, plan_y = 0.5 where id = '101'`)).rejects.toThrow();
    await h.db.execute(sql`update rooms set plan_x = 0.5, plan_y = 0 where id = '101'`);
    // Plan: alle Angaben oder keine
    await expect(h.db.execute(sql`update building_floors set plan_key = 'k' where id = 'f1'`)).rejects.toThrow();
    await h.db.execute(
      sql`update building_floors set plan_key = 'k', plan_thumb_key = 't', plan_mime = 'image/jpeg', plan_width = 10, plan_height = 10, plan_alt = 'Plan der Etage EG', plan_updated_at = now() where id = 'f1'`,
    );
  });
});
