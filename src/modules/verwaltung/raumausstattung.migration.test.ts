// RS-05: Update einer Bestandsinstallation – Migration 0117 übernimmt die feste Ausstattungsliste `rooms.equipment` 1:1 in den
// Katalog (`room_equipment_types`, Schlüssel bleibt ID) und die Zuordnung je Raum (`room_equipment_items`, Menge 1), danach
// entfällt die Spalte. Die In-Memory-DB wird zunächst nur bis 0116 migriert (Journal gekürzt), mit den Demo-Räumen im alten
// Format gefüllt und dann vollständig. Raumsuche und Solver-Eingabe liefern vorher und nachher dasselbe.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb, type DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { ROOMS } from "@/core/seed/data";
import { listRooms, searchRooms, type RoomFilter, type RoomInfo } from "@/modules/stundenplan/raeume";
import { solverInputFromDb } from "@/modules/stundenplan/solver-input";
import { DEFAULT_EQUIPMENT_TYPES, listEquipmentTypes } from "./raumausstattung";

const UNTIL = "0116_hb_01_handbuch";
const YEAR = { id: "sj-2026-27", startsOn: "2026-08-01", endsOn: "2027-07-31" };
const PERIODS = [1, 2, 3, 4, 5, 6];

type OldRoom = Omit<RoomInfo, "equipment"> & { equipment: string[] };

describe("Migration 0117 (Ausstattungskatalog) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0117_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("übernimmt alle Räume mit ihrer Ausstattung 1:1; Raumsuche und Solver-Eingabe bleiben gleich", async () => {
    // Bestand im alten Format: die Demo-Räume (Schlüssel der festen Liste), ein stillgelegter Raum und einer ohne Ausstattung
    const old = [
      ...ROOMS.map((r) => ({ ...r, equipment: Object.keys(r.equipment), active: true })),
      { id: "ALT", name: "Altbau", kind: "klassenraum" as const, building: null, floor: null, capacity: 20, equipment: ["beamer", "audio"], accessible: false, active: false },
      { id: "LEER", name: "Abstellraum", kind: "sonstiges" as const, building: null, floor: null, capacity: null, equipment: [], accessible: false, active: true },
    ];
    for (const r of old) {
      const arr = `{${r.equipment.join(",")}}`;
      await h.db.execute(
        sql`insert into rooms (id, name, kind, building, floor, capacity, equipment, accessible, active) values (${r.id}, ${r.name}, ${r.kind}, ${r.building}, ${r.floor}, ${r.capacity}, ${arr}::text[], ${r.accessible}, ${r.active})`,
      );
    }
    await h.db.execute(sql`insert into school_years (id, name, starts_on, ends_on, is_current) values (${YEAR.id}, '2026/27', ${YEAR.startsOn}, ${YEAR.endsOn}, true)`);

    // vorher: Räume so, wie die alte Raumsuche sie sah (Ausstattung = Schlüssel der festen Liste)
    const before = rowsOf<{ id: string; equipment: string[] }>(await h.db.execute(sql`select id, equipment from rooms order by id`));
    expect(before.find((r) => r.id === "IF1")!.equipment.sort()).toEqual(["beamer", "lehrer_pc", "schueler_pcs"]);
    const oldList: OldRoom[] = old.filter((r) => r.active).map((r) => ({ ...r, equipment: before.find((b) => b.id === r.id)!.equipment }));
    const asNew = (rs: OldRoom[]): RoomInfo[] => rs.map((r) => ({ ...r, equipment: r.equipment.map((typeId) => ({ typeId, name: typeId, quantity: 1 })) }));
    const filters: RoomFilter[] = [
      { periodNrs: [] },
      ...DEFAULT_EQUIPMENT_TYPES.map((t) => ({ periodNrs: [], equipment: [t.id] })),
      { periodNrs: [], equipment: ["beamer", "waschbecken"] },
      { periodNrs: [], equipment: ["beamer"], minCapacity: 28, kind: "nw" as const },
      { periodNrs: [], equipment: ["schueler_pcs"], accessible: true },
    ];
    const search = (rs: RoomInfo[]) => filters.map((f) => searchRooms(rs, new Map(), f, PERIODS).map((r) => r.id));
    const expected = search(asNew(oldList));
    expect(expected[1 + DEFAULT_EQUIPMENT_TYPES.findIndex((t) => t.id === "abzug")]).toEqual(["NW2"]);
    const solverBefore = await solverInputFromDb(h.db, YEAR, "2026-10-05");

    await h.migrate();

    // Spalte weg, Katalog mit den acht Vorgaben, jede Zuordnung genau einmal mit Menge 1
    const cols = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from information_schema.columns where table_name = 'rooms' and column_name = 'equipment'`));
    expect(cols[0]!.n).toBe(0);
    expect((await listEquipmentTypes(h.db)).map((t) => [t.id, t.name]).sort()).toEqual(DEFAULT_EQUIPMENT_TYPES.map((t) => [t.id, t.name]).sort());
    const items = rowsOf<{ room_id: string; type_id: string; quantity: number }>(await h.db.execute(sql`select room_id, type_id, quantity from room_equipment_items`));
    const want = before.flatMap((r) => r.equipment.map((e) => `${r.id}:${e}:1`)).sort();
    expect(items.map((i) => `${i.room_id}:${i.type_id}:${i.quantity}`).sort()).toEqual(want);
    expect(items.length).toBe(old.reduce((n, r) => n + r.equipment.length, 0));

    // Raumsuche liefert dasselbe (jetzt über den Katalog), auch die stillgelegten Räume bleiben außen vor
    const after = await listRooms(h.db);
    expect(search(after)).toEqual(expected);
    expect(after.find((r) => r.id === "IF1")!.equipment.map((e) => e.name)).toEqual(["Beamer", "Lehrer-PC", "Schüler-PCs"]);
    expect((await listRooms(h.db, true)).find((r) => r.id === "ALT")!.equipment.map((e) => e.typeId)).toEqual(["audio", "beamer"]);
    // Solver-Eingabe (Räume nach Art und Plätzen) unverändert
    const solverAfter = await solverInputFromDb(h.db, YEAR, "2026-10-05");
    expect(solverAfter.rooms).toEqual(solverBefore.rooms);
    expect(solverAfter.rooms.length).toBe(oldList.length);
  });
});
