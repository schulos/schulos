// GT-13: Update einer Bestandsinstallation – die Migration ergänzt die Befristung am Konto und die Tabelle der externen Leitungen. Die In-Memory-DB wird
// zunächst nur bis zur Migration davor migriert (Journal gekürzt) und dann vollständig: Bestandskonten bleiben unbefristet und
// behalten ihre Rechte, die Zuordnung geht mit dem Konto.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { loadPermissions } from "@/core/permissions";

const TAG = /^\d{4}_gt_13_externe_leitung$/;

describe("Migration GT-13 (externe Leitungen) auf Bestandsdaten", () => {
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

  it("Bestandskonten bleiben unbefristet und aktiv; die Zuordnung geht mit dem Konto", async () => {
    await h.db.execute(sql`insert into users (id, name, email, role) values ('p1', 'Person Eins', 'p1@x.invalid', 'personal')`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g1', 'AG Test', 'ag-test', 'ag')`);
    await h.migrate();
    expect(rowsOf(await h.db.execute(sql`select status, expires_on from users where id = 'p1'`))).toEqual([{ status: "active", expires_on: null }]);
    expect((await loadPermissions(h.db, "p1")).locked).toBe(false);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_external_leaders`))).toEqual([]);
    await h.db.execute(sql`insert into ganztag_external_leaders (user_id, group_id, provider, confidentiality_at) values ('p1', 'g1', 'Verein', now())`);
    await h.db.execute(sql`delete from users where id = 'p1'`);
    expect(rowsOf(await h.db.execute(sql`select * from ganztag_external_leaders`))).toEqual([]);
  });
});
