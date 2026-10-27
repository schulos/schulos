// SP3-DEP: Update einer Bestandsinstallation – Migration 0107 (Teilzeit-Anteil, Pflicht 2. Halbjahr, Anrechnungen mit Gültigkeit)
// lässt vorhandene Deputate unverändert rechnen. Die In-Memory-DB wird zunächst nur bis 0106 migriert (Journal gekürzt), mit alten
// Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { deputyAccounts } from "./deputate";

const UNTIL = "0106_r1b_vertretung_pruefen";

describe("Migration 0107 (Deputatsmodell) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0107_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Pflicht und Ermäßigungen aus dem Bestand: gleiche Pflicht, gleiches Soll in beiden Halbjahren, keine neuen Angaben", async () => {
    await h.db.execute(sql`insert into school_years (id, name, starts_on, ends_on, is_current, term2_starts_on) values ('sj', '2026/27', '2026-08-01', '2027-07-31', true, '2027-02-01')`);
    await h.db.execute(
      sql`insert into users (id, name, username, role, email, email_verified) values ('t1', 'Eins', 't1', 'lehrkraft', 't1@x', false), ('t2', 'Zwei', 't2', 'lehrkraft', 't2@x', false), ('t3', 'Drei', 't3', 'lehrkraft', 't3@x', false)`,
    );
    await h.db.execute(sql`insert into timetable_deputies (school_year_id, teacher_id, obligation) values ('sj', 't1', 14), ('sj', 't2', 20.5)`);
    await h.db.execute(sql`insert into timetable_reductions (id, school_year_id, teacher_id, reason, hours) values ('r1', 'sj', 't2', 'koordination', 3), ('r2', 'sj', 't3', 'alter', 1)`);

    await h.migrate();
    const totals = [
      { id: "t1", code: "EIN", name: "Eins", assigned: 14, planned: 14 },
      { id: "t2", code: "ZWE", name: "Zwei", assigned: 16, planned: 16 },
      { id: "t3", code: "DRE", name: "Drei", assigned: 25, planned: 25 },
    ];
    const expected = [
      { id: "t1", obligation: 14, isDefault: false, target: 14, balance: 0 },
      { id: "t2", obligation: 20.5, isDefault: false, target: 17.5, balance: -1.5 },
      { id: "t3", obligation: 25.5, isDefault: true, target: 24.5, balance: 0.5 },
    ];
    for (const day of ["2026-10-05", "2027-03-01"]) {
      const acc = await deputyAccounts(h.db, "sj", totals, 25.5, day);
      expect(acc.map(({ id, obligation, isDefault, target, balance }) => ({ id, obligation, isDefault, target, balance }))).toEqual(expected);
      expect(acc.every((a) => a.terms === null && a.otherReductions.length === 0 && a.settings.employmentPercent === null && a.settings.obligationTerm2 === null)).toBe(true);
    }
  });
});
