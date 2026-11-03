// GT-09: Update einer Bestandsinstallation – die Migration legt Heimwegregeln und Tagesdaten neu an. Die In-Memory-DB wird zunächst
// nur bis zur Migration davor migriert (Journal gekürzt), mit einem Termin samt Markierung gefüllt und dann vollständig: Bestand
// bleibt, es gibt noch keinen Heimweg, und die neuen Tabellen hängen an Termin bzw. Konto.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";

const TAG = /^\d{4}_gt_09_heimweg$/;

describe("Migration GT-09 (Heimweg) auf Bestandsdaten", () => {
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

  it("Bestand bleibt, Heimweg leer, Tagesdaten gehen mit dem Termin", async () => {
    await h.db.execute(sql`insert into users (id, name, email, role) values ('s1', 'Kind Eins', 's1@x.invalid', 'schueler')`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g1', 'AG Test', 'ag-test', 'ag')`);
    await h.db.execute(sql`insert into ganztag_sessions (id, group_id, date, starts_at, ends_at) values ('t1', 'g1', '2026-11-10', '14:00', '15:00')`);
    await h.db.execute(sql`insert into ganztag_marks (session_id, student_id, status) values ('t1', 's1', 'anwesend')`);

    await h.migrate();

    expect(rowsOf(await h.db.execute(sql`select session_id, student_id, status from ganztag_marks`))).toEqual([{ session_id: "t1", student_id: "s1", status: "anwesend" }]);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_way_home_rules`))).toEqual([]);
    // nur die Art – unbekannte Werte lehnt die Datenbank ab
    await expect(h.db.execute(sql`insert into ganztag_way_home_rules (group_id, student_id, way) values ('g1', 's1', 'oma')`)).rejects.toThrow();
    await h.db.execute(sql`insert into ganztag_way_home_rules (group_id, student_id, way) values ('g1', 's1', 'abgeholt')`);
    await h.db.execute(sql`insert into ganztag_departures (session_id, student_id, way, left_at) values ('t1', 's1', 'bus', now())`);
    await h.db.execute(sql`delete from ganztag_sessions where id = 't1'`);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_departures`))).toEqual([]);
    await h.db.execute(sql`delete from users where id = 's1'`);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_way_home_rules`))).toEqual([]);
  });
});
