// SP3-01: Update einer Bestandsinstallation – Migration 0111 macht den vorhandenen Plan zu „Bestand 1.0“ (gültig im laufenden,
// archiviert in abgelaufenen Schuljahren); die Stunden bleiben Zeile für Zeile, wie sie waren, und lesen sich wie vorher. Die In-Memory-DB
// wird zunächst nur bis 0110 migriert (Journal gekürzt), mit alten Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { addDays, toBerlinDate } from "@/core/time";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { ensureBaseVersions } from "./planversionen";
import { regularSlots } from "./service";

const UNTIL = "0110_vt04_benachrichtigung";

describe("Migration 0111 (Planversionen) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0111_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Bestand 1.0 je Schuljahr mit Stunden, Herkunft nur an heute geltenden Stunden, Stunden und Leser unverändert", async () => {
    // die Migration rechnet mit dem echten Datum (Berliner Zeit) – Testdaten liegen relativ dazu
    const today = toBerlinDate(new Date());
    const cur = { start: addDays(today, -60), end: addDays(today, 300) };
    await h.db.execute(sql`insert into subjects (id, name, color) values ('M', 'Mathematik', '#123456')`);
    await h.db.execute(sql`insert into periods (nr, starts_at, ends_at) values (1, '08:00', '08:45')`);
    await h.db.execute(sql`insert into users (id, name, username, role, email, email_verified) values ('t1', 'Eins', 't1', 'lehrkraft', 't1@x', false)`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g7a', 'Klasse 7a', '7a', 'klasse')`);
    await h.db.execute(
      sql`insert into school_years (id, name, starts_on, ends_on, is_current) values ('sy-alt', '2019/20', '2019-08-01', '2020-07-31', false), ('sy-jetzt', 'jetzt', ${cur.start}, ${cur.end}, true), ('sy-leer', '2099/00', '2099-08-01', '2100-07-31', false)`,
    );
    await h.db.execute(
      sql`insert into timetable_lessons (id, group_id, weekday, period_nr, subject_id, teacher_id, valid_from, valid_until, fixed) values
        ('l-heute', 'g7a', 0, 1, 'M', 't1', ${cur.start}, ${cur.end}, true),
        ('l-vorbei', 'g7a', 1, 1, 'M', 't1', ${cur.start}, ${addDays(today, -1)}, false),
        ('l-spaeter', 'g7a', 2, 1, 'M', null, ${addDays(today, 30)}, null, false),
        ('l-alt', 'g7a', 3, 1, 'M', 't1', '2019-08-01', '2020-07-31', false)`,
    );
    const lessonsSql = sql`select id, group_id, weekday, period_nr, subject_id, teacher_id, room_id, week, valid_from, valid_until, coupling_id, fixed, solver_run_id, created_at from timetable_lessons order by id`;
    const before = rowsOf<Record<string, unknown>>(await h.db.execute(lessonsSql));

    await h.migrate();

    // Stunden Zeile für Zeile unverändert (außer der neuen Herkunft)
    expect(rowsOf<Record<string, unknown>>(await h.db.execute(lessonsSql))).toEqual(before);
    const versions = rowsOf<Record<string, unknown>>(
      await h.db.execute(sql`select id, school_year_id, major, minor, name, status, source, valid_from, valid_until, created_by, parent_version_id, undo from timetable_plan_versions order by school_year_id`),
    );
    expect(versions.map((v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== "id")))).toEqual([
      { school_year_id: "sy-alt", major: 1, minor: 0, name: "Bestand", status: "archiviert", source: "bestand", valid_from: "2019-08-01", valid_until: "2020-07-31", created_by: null, parent_version_id: null, undo: null },
      { school_year_id: "sy-jetzt", major: 1, minor: 0, name: "Bestand", status: "gueltig", source: "bestand", valid_from: cur.start, valid_until: null, created_by: null, parent_version_id: null, undo: null },
    ]);
    const current = versions.find((v) => v.school_year_id === "sy-jetzt")!.id;
    expect(rowsOf(await h.db.execute(sql`select id, plan_version_id from timetable_lessons order by id`))).toEqual([
      { id: "l-alt", plan_version_id: null },
      { id: "l-heute", plan_version_id: current },
      { id: "l-spaeter", plan_version_id: null },
      { id: "l-vorbei", plan_version_id: null },
    ]);
    expect(rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from timetable_draft_lessons`))[0]!.n).toBe(0);

    // Leser des gültigen Plans wie vorher: Regelplan der 7a heute bzw. in 30 Tagen
    expect((await regularSlots(h.db, { kind: "group", id: "g7a" }, today)).map((s) => s.lessonId)).toEqual(["l-heute"]);
    expect((await regularSlots(h.db, { kind: "group", id: "g7a" }, addDays(today, 30))).map((s) => s.lessonId).sort()).toEqual(["l-heute", "l-spaeter"]);

    // die Laufzeit-Variante derselben Regel legt nichts doppelt an
    expect(await ensureBaseVersions(h.db, today)).toBe(0);
    // höchstens eine gültige Version je Schuljahr, Nummern veröffentlichter Versionen eindeutig
    await expect(
      h.db.execute(sql`insert into timetable_plan_versions (id, school_year_id, major, minor, name, status, source) values ('x', 'sy-jetzt', 2, 0, 'zweite', 'gueltig', 'live_copy')`),
    ).rejects.toThrow();
    await expect(
      h.db.execute(sql`insert into timetable_plan_versions (id, school_year_id, major, minor, name, status, source) values ('y', 'sy-jetzt', 1, 0, 'gleiche Nummer', 'archiviert', 'live_copy')`),
    ).rejects.toThrow();
    // Entwürfe dürfen die vorgesehene Nummer teilen (Varianten)
    await h.db.execute(
      sql`insert into timetable_plan_versions (id, school_year_id, major, minor, name, status, source) values ('d1', 'sy-jetzt', 2, 0, 'A', 'entwurf', 'live_copy'), ('d2', 'sy-jetzt', 2, 0, 'B', 'entwurf', 'variant_of')`,
    );
  });
});
