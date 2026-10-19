// SP-06: Update einer Bestandsinstallation – Migration 0093 auf einer Datenbank mit Läufen und Stunden aus der Zeit davor.
// Dafür wird eine In-Memory-DB zunächst nur bis 0092 migriert (Journal gekürzt), mit alten Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, rowsOf, type DbHandle } from "@/core/db/client";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { timetableLessons, timetableSolverRuns } from "@/core/db/schema";
import { getRun, listRuns, proposedLessons } from "./solverlauf";

const UNTIL = "0092_kurswahl_lesen";

describe("Migration 0093 (Solver-Läufe) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    // Migrationsordner bis 0092 kopieren (SQL-Dateien + gekürztes Journal)
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0093_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("alte Läufe und Stunden bleiben lesbar, neue Spalten mit Vorgaben; Enum um queued/cancelled erweitert; Löschen eines Laufs leert nur die Herkunft", async () => {
    // Stand vor 0093: ein fertiger Lauf im alten Format (Einheiten ohne Teile) und ein rechnender
    await h.db.execute(sql`insert into school_years (id, name, starts_on, ends_on, is_current) values ('sj', '2026/27', '2026-08-01', '2027-07-31', true)`);
    await h.db.execute(sql`insert into subjects (id, name, color) values ('M', 'Mathematik', '#123456')`);
    await h.db.execute(sql`insert into groups (id, name, slug, kind) values ('g7a', 'Klasse 7a', '7a', 'klasse')`);
    await h.db.execute(sql`insert into periods (nr, starts_at, ends_at) values (1, '08:00', '08:45'), (2, '08:50', '09:35')`);
    const stored = {
      result: { placements: [{ unitId: "u1", weekday: 0, periodNr: 1, roomId: null }], unplaced: [], score: 3, breakdown: {}, items: [], stats: { units: 1, iterations: 10, improved: 1 } },
      units: [{ id: "u1", label: "7a M", groupIds: ["g7a"], teacherIds: [], subjectId: "M", length: 2 }],
      keptLessonIds: [],
      refYmd: "2026-10-05",
    };
    await h.db.execute(sql`insert into timetable_solver_runs (id, school_year_id, status, progress, seed, iterations, result, finished_at) values ('alt', 'sj', 'done', 100, 3, 10, ${JSON.stringify(stored)}::jsonb, now())`);
    await h.db.execute(sql`insert into timetable_solver_runs (id, school_year_id, status, progress, seed) values ('rechnet', 'sj', 'running', 40, 4)`);
    await h.db.execute(sql`insert into timetable_lessons (id, group_id, weekday, period_nr, subject_id, valid_from) values ('l1', 'g7a', 0, 1, 'M', '2026-08-01')`);
    const columnsBefore = rowsOf(await h.db.execute(sql`select column_name from information_schema.columns where table_name = 'timetable_solver_runs'`)).map((r) => r.column_name);
    expect(columnsBefore).not.toContain("params");

    // Update: Rest der Migrationen (0093 …)
    await h.migrate();
    const columns = rowsOf(await h.db.execute(sql`select column_name from information_schema.columns where table_name = 'timetable_solver_runs'`)).map((r) => r.column_name);
    for (const c of ["label", "params", "metrics", "log", "cancel_requested", "heartbeat_at", "applied_by", "applied_at", "undo"]) expect(columns).toContain(c);
    const enumValues = rowsOf(await h.db.execute(sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'solver_run_status' order by enumsortorder`)).map((r) => r.enumlabel);
    expect(enumValues).toEqual(["running", "done", "failed", "applied", "queued", "cancelled"]);

    const alt = (await getRun(h.db, "alt"))!;
    expect(alt).toMatchObject({ status: "done", seed: 3, label: null, params: null, metrics: null, log: [], cancelRequested: false, heartbeatAt: null, appliedBy: null });
    expect(alt.stored!.units[0]!.parts).toBeUndefined();
    // altes Einheiten-Format ohne Teile → Vorschau wie bisher (Doppelstunde = zwei Zeilen)
    expect(proposedLessons(alt.stored!).map((l) => `${l.groupId}:${l.weekday}-${l.periodNr}`)).toEqual(["g7a:0-1", "g7a:0-2"]);
    expect((await listRuns(h.db, { schoolYearId: "sj" })).map((r) => r.id).sort()).toEqual(["alt", "rechnet"]);

    // neue Werte nutzbar; Herkunft an Stunden mit `on delete set null`
    await h.db.insert(timetableSolverRuns).values({ id: "neu", schoolYearId: "sj", status: "queued", seed: 1 });
    await h.db.update(timetableSolverRuns).set({ status: "cancelled" }).where(sql`id = 'neu'`);
    await h.db.update(timetableLessons).set({ solverRunId: "alt" }).where(sql`id = 'l1'`);
    await h.db.delete(timetableSolverRuns).where(sql`id = 'alt'`);
    const [l1] = await h.db.select().from(timetableLessons);
    expect(l1).toMatchObject({ id: "l1", solverRunId: null });
    expect((await listRuns(h.db, { status: ["cancelled"] })).map((r) => r.id)).toEqual(["neu"]);
  });
});
