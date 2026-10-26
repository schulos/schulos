// SP2-12: Update einer Bestandsinstallation – Migration 0105 legt Lehrfächer an und belegt sie aus Lehraufträgen und Stundenplan vor.
// Die In-Memory-DB wird zunächst nur bis 0104 migriert (Journal gekürzt), mit alten Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { teacherSubjectMap } from "./lehrfaecher";

const UNTIL = "0104_sp2_07_vertretung_stufe2";

describe("Migration 0105 (Lehrfächer, Prognose) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0105_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Lehrfächer aus Lehraufträgen und Stunden – nur für Lehrkräfte, ohne Doppelte; Prognose-Tabellen leer", async () => {
    await h.db.execute(sql`insert into school_years (id, name, starts_on, ends_on, is_current) values ('sj', '2026/27', '2026-08-01', '2027-07-31', true)`);
    await h.db.execute(sql`insert into subjects (id, name, color) values ('M', 'Mathematik', '#123456'), ('PH', 'Physik', '#654321'), ('D', 'Deutsch', '#111111')`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g7a', 'Klasse 7a', '7a', 'klasse')`);
    await h.db.execute(sql`insert into periods (nr, starts_at, ends_at) values (1, '08:00', '08:45')`);
    await h.db.execute(
      sql`insert into users (id, name, username, role, email, email_verified) values ('t1', 'Eins', 't1', 'lehrkraft', 't1@x', false), ('t2', 'Zwei', 't2', 'lehrkraft', 't2@x', false), ('v1', 'Verwaltung', 'v1', 'verwaltung', 'v1@x', false)`,
    );
    await h.db.execute(sql`insert into timetable_assignments (id, school_year_id, subject_id, hours) values ('a1', 'sj', 'M', 4), ('a2', 'sj', 'D', 4)`);
    await h.db.execute(sql`insert into timetable_assignment_teachers (assignment_id, teacher_id) values ('a1', 't1'), ('a2', 'v1')`);
    // Stunde mit Lehrauftrags-Fach (doppelt) und eine ohne Lehrauftrag
    await h.db.execute(
      sql`insert into timetable_lessons (id, group_id, weekday, period_nr, subject_id, teacher_id, valid_from) values ('l1', 'g7a', 0, 1, 'M', 't1', '2026-08-01'), ('l2', 'g7a', 1, 1, 'PH', 't2', '2026-08-01')`,
    );

    await h.migrate();
    const map = await teacherSubjectMap(h.db);
    expect(Object.fromEntries(map)).toEqual({ t1: ["M"], t2: ["PH"] });
    const changes = await h.db.execute(sql`select count(*)::int as n from timetable_staff_changes`);
    expect(JSON.stringify(changes)).toContain('"n":0');
  });
});
