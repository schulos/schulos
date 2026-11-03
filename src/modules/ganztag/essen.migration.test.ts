// GT-11: Update einer Bestandsinstallation – die Migration legt Speiseplan und Essensanmeldungen neu an. Die In-Memory-DB wird
// zunächst nur bis zur Migration davor migriert (Journal gekürzt) und dann vollständig: leer, nur nummerierte Menüs 1–4, die
// Anmeldung geht mit dem Konto.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";

const TAG = /^\d{4}_gt_11_mittagessen$/;

describe("Migration GT-11 (Mittagessen) auf Bestandsdaten", () => {
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

  it("leer nach dem Update; Menüs nur 1–4 mit Text, Anmeldung geht mit dem Konto", async () => {
    await h.db.execute(sql`insert into users (id, name, email, role) values ('s1', 'Kind Eins', 's1@x.invalid', 'schueler')`);
    await h.migrate();
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_menus`))).toEqual([]);
    await expect(h.db.execute(sql`insert into ganztag_menus (date, number, title) values ('2026-11-10', 5, 'Suppe')`)).rejects.toThrow();
    await expect(h.db.execute(sql`insert into ganztag_menus (date, number, title) values ('2026-11-10', 1, '')`)).rejects.toThrow();
    await h.db.execute(sql`insert into ganztag_menus (date, number, title) values ('2026-11-10', 1, 'Suppe')`);
    await h.db.execute(sql`insert into ganztag_meal_orders (date, student_id, menu_number) values ('2026-11-10', 's1', 1)`);
    await h.db.execute(sql`delete from users where id = 's1'`);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_meal_orders`))).toEqual([]);
  });
});
