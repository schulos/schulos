// VT-01: Update einer Bestandsinstallation – Migration 0109 (Grund-Kategorie, interner Hinweis, „nur Betreuung“, updated_*,
// Kenntnisnahme, Historie, Material ohne Abwesenheit, Tagesmitteilungen) lässt vorhandene Vertretungen und Materialien unverändert.
// Die In-Memory-DB wird zunächst nur bis 0108 migriert (Journal gekürzt), mit alten Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { substitutionsOn } from "./vertretung";

const UNTIL = "0108_sp3_la_class_map";

describe("Migration 0109 (Vertretung mehr Infos) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0109_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Vertretungen und Material bleiben, neue Angaben leer; Material ohne Abwesenheit danach möglich", async () => {
    await h.db.execute(sql`insert into subjects (id, name, color) values ('M', 'Mathematik', '#123456')`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g7a', 'Klasse 7a', '7a', 'klasse')`);
    await h.db.execute(sql`insert into periods (nr, starts_at, ends_at) values (1, '08:00', '08:45')`);
    await h.db.execute(
      sql`insert into users (id, name, username, role, email, email_verified) values ('t1', 'Eins', 't1', 'lehrkraft', 't1@x', false), ('t2', 'Zwei', 't2', 'lehrkraft', 't2@x', false)`,
    );
    await h.db.execute(sql`insert into timetable_lessons (id, group_id, weekday, period_nr, subject_id, teacher_id, valid_from) values ('l1', 'g7a', 0, 1, 'M', 't1', '2026-08-01')`);
    await h.db.execute(
      sql`insert into timetable_substitutions (id, lesson_id, date, kind, substitute_id, note, created_by, created_at) values ('s1', 'l1', '2026-10-05', 'substitute', 't2', 'Buch S. 3', 't2', '2026-10-01T07:00:00Z'), ('s2', 'l1', '2026-10-12', 'cancel', null, null, null, '2026-10-01T07:00:00Z')`,
    );
    await h.db.execute(sql`insert into timetable_absences (id, teacher_id, starts_on, ends_on, reason) values ('a1', 't1', '2026-10-05', '2026-10-05', 'krank')`);
    await h.db.execute(sql`insert into timetable_absence_materials (id, absence_id, lesson_id, date, text) values ('m1', 'a1', 'l1', '2026-10-05', 'Arbeitsblatt')`);

    await h.migrate();

    const subs = rowsOf<Record<string, unknown>>(
      await h.db.execute(
        sql`select id, kind, substitute_id, note, created_by, reason, internal_note, supervision_only, updated_by, updated_at, acknowledged_at from timetable_substitutions order by id`,
      ),
    );
    expect(subs).toEqual([
      { id: "s1", kind: "substitute", substitute_id: "t2", note: "Buch S. 3", created_by: "t2", reason: null, internal_note: null, supervision_only: false, updated_by: null, updated_at: null, acknowledged_at: null },
      { id: "s2", kind: "cancel", substitute_id: null, note: null, created_by: null, reason: null, internal_note: null, supervision_only: false, updated_by: null, updated_at: null, acknowledged_at: null },
    ]);
    // Vertretungsplan liest den Bestand wie vorher (ohne Kategorie)
    const plan = await substitutionsOn(h.db, ["2026-10-05", "2026-10-12"]);
    expect(plan.map((e) => [e.id, e.kind, e.note, e.reason, e.supervisionOnly])).toEqual([
      ["s1", "substitute", "Buch S. 3", null, false],
      ["s2", "cancel", null, null, false],
    ]);
    expect(rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from timetable_substitution_changes`))[0]!.n).toBe(0);

    // Material: Bestand bleibt; dazu eines ohne Abwesenheit an derselben Stunde, ein zweites ohne Abwesenheit scheitert
    expect(rowsOf(await h.db.execute(sql`select id, absence_id, text from timetable_absence_materials`))).toEqual([{ id: "m1", absence_id: "a1", text: "Arbeitsblatt" }]);
    await h.db.execute(sql`insert into timetable_absence_materials (id, lesson_id, date, text) values ('m2', 'l1', '2026-10-05', 'ohne Abwesenheit')`);
    await expect(h.db.execute(sql`insert into timetable_absence_materials (id, lesson_id, date, text) values ('m3', 'l1', '2026-10-05', 'doppelt')`)).rejects.toThrow();
    await expect(h.db.execute(sql`insert into timetable_absence_materials (id, absence_id, lesson_id, date, text) values ('m4', 'a1', 'l1', '2026-10-05', 'doppelt')`)).rejects.toThrow();
    // „nur Betreuung“ nur bei einer Vertretung
    await expect(h.db.execute(sql`update timetable_substitutions set supervision_only = true where id = 's2'`)).rejects.toThrow();
  });
});
