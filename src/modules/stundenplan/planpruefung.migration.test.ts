// SP3-03: Update einer Bestandsinstallation – Migration 0112 gibt `stundenplan.review` der Gruppe Schulleitung (nur mit fester ID und Slug,
// idempotent, kein doppelter Grant) und legt `timetable_plan_comments` an. Die In-Memory-DB wird zunächst nur bis 0111 migriert (Journal
// gekürzt), mit alten Daten gefüllt und dann vollständig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import type { PgliteDatabase } from "drizzle-orm/pglite";

const UNTIL = "0111_sp3_01_planversionen";

async function migratedUntil(): Promise<{ h: DbHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
  cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
  const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
  expect(cut).toBeGreaterThan(0);
  expect(journal.entries[cut + 1]?.tag).toMatch(/^0112_/);
  writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
  const h = openDb();
  await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  return { h, tmp };
}

const reviewGrants = async (h: DbHandle) =>
  rowsOf<{ group_id: string | null; role: string | null }>(await h.db.execute(sql`select group_id, role from grants where permission = 'stundenplan.review' order by group_id`));

describe("Migration 0112 (Prüfung & Freigabe) auf Bestandsdaten", () => {
  const handles: { h: DbHandle; tmp: string }[] = [];
  afterAll(async () => {
    for (const x of handles) {
      await x.h.close();
      rmSync(x.tmp, { recursive: true, force: true });
    }
  });

  let withGroup: DbHandle;
  let withoutGroup: DbHandle;
  beforeAll(async () => {
    const a = await migratedUntil();
    const b = await migratedUntil();
    handles.push(a, b);
    withGroup = a.h;
    withoutGroup = b.h;
    await withGroup.db.execute(sql`insert into groups (id, name, slug, kind) values ('g-schulleitung', 'Schulleitung', 'schulleitung', 'gremium')`);
    // eine gleichnamige Gruppe mit anderer ID bekommt nichts (keine stille Rechteausweitung)
    await withoutGroup.db.execute(sql`insert into groups (id, name, slug, kind) values ('g-sl-eigen', 'Schulleitung', 'schulleitung', 'gremium')`);
    await withGroup.migrate();
    await withoutGroup.migrate();
  }, 180_000);

  it("Grant an die Gruppe Schulleitung (feste ID + Slug), sonst keiner; Tabelle für Kommentare da", async () => {
    expect(await reviewGrants(withGroup)).toEqual([{ group_id: "g-schulleitung", role: null }]);
    expect(await reviewGrants(withoutGroup)).toEqual([]);
    const cols = rowsOf<{ column_name: string }>(
      await withGroup.db.execute(sql`select column_name from information_schema.columns where table_name = 'timetable_plan_comments' order by column_name`),
    ).map((r) => r.column_name);
    expect(cols).toEqual(["author_id", "body", "created_at", "from_preview", "group_id", "id", "period_nr", "resolved_at", "resolved_by", "target_kind", "teacher_id", "version_id", "weekday"]);
  });

  it("idempotent: erneut ausgeführt kein zweiter Grant", async () => {
    const file = readFileSync(join(MIGRATIONS_DIR, "0112_sp3_03_freigabe.sql"), "utf8");
    const grant = file.slice(file.indexOf("INSERT INTO \"grants\""));
    await withGroup.db.execute(sql.raw(grant));
    expect(await reviewGrants(withGroup)).toHaveLength(1);
  });
});
