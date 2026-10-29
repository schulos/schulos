// RS-10: Update einer Bestandsinstallation – Migration 0122 übernimmt Gebäude/Etage aus dem Freitext an `rooms` in die
// Stammdaten (`buildings`, `building_floors`, `rooms.building_id`/`floor_id`). Die In-Memory-DB wird zunächst nur bis 0121
// migriert (Journal gekürzt), mit den Demo-Räumen und Sonderfällen im alten Format gefüllt und dann vollständig. Die Anzeige
// (Gebäude/Etage je Raum, Gruppen und Reihenfolge im Raumfinder) ist vorher und nachher gleich.
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
import { listBuildings } from "./gebaeude-etagen";
import { roomDirectory } from "./raumsteckbrief";

const UNTIL = "0121_rs_08_raumlayout";

const place = (r: { building: string | null; floor: string | null }) => [r.building, r.floor].filter(Boolean).join(", ");

describe("Migration 0122 (Gebäude/Etagen) auf Bestandsdaten", () => {
  let h: DbHandle;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "schulos-mig-"));
    cpSync(MIGRATIONS_DIR, tmp, { recursive: true, filter: (src) => !src.endsWith("_snapshot.json") });
    const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((e) => e.tag === UNTIL);
    expect(cut).toBeGreaterThan(0);
    expect(journal.entries[cut + 1]?.tag).toMatch(/^0122_/);
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }));
    h = openDb();
    await migrate(h.db as unknown as PgliteDatabase, { migrationsFolder: tmp });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("übernimmt Gebäude und Etagen aus dem Freitext; Anzeige, Gruppen und Reihenfolge bleiben gleich", async () => {
    // Bestand: die Demo-Räume, dazu Sonderfälle (andere Schreibweise/Leerraum, Etage ohne Gebäude, leere Angaben, stillgelegt)
    const old = [
      ...ROOMS.map((r) => ({ id: r.id, name: r.name, kind: r.kind, building: r.building as string | null, floor: r.floor as string | null, active: true })),
      { id: "X1", name: "Nebenraum", kind: "sonstiges" as const, building: " hauptgebäude ", floor: "eg", active: true },
      { id: "X2", name: "Lager", kind: "sonstiges" as const, building: null, floor: "UG", active: true },
      { id: "X3", name: "Ohne Ort", kind: "sonstiges" as const, building: "  ", floor: "", active: true },
      { id: "ALT", name: "Altbau", kind: "klassenraum" as const, building: "Altbau", floor: "Dachgeschoss", active: false },
    ];
    for (const r of old)
      await h.db.execute(sql`insert into rooms (id, name, kind, building, floor, accessible, active) values (${r.id}, ${r.name}, ${r.kind}, ${r.building}, ${r.floor}, false, ${r.active})`);
    // vorher: Anzeige je Raum und Gruppenreihenfolge wie die alte Raumliste (Gebäude alphabetisch, „Ohne Gebäude“ für leer)
    const before = new Map(old.map((r) => [r.id, place({ building: r.building?.trim() || null, floor: r.floor?.trim() || null })]));
    const demoGroupsBefore = [...new Set(ROOMS.map((r) => r.building).sort((a, b) => a.localeCompare(b, "de")))];

    await h.migrate();

    const after = rowsOf<{ id: string; building: string | null; floor: string | null; building_id: string | null; floor_id: string | null }>(
      await h.db.execute(sql`select id, building, floor, building_id, floor_id from rooms`),
    );
    const byId = new Map(after.map((r) => [r.id, r]));
    // Demo-Räume: Anzeige exakt gleich, jeder Raum verknüpft
    for (const r of ROOMS) {
      expect(place(byId.get(r.id)!), r.id).toBe(before.get(r.id));
      expect(byId.get(r.id)!.building_id, r.id).not.toBeNull();
      expect(byId.get(r.id)!.floor_id, r.id).not.toBeNull();
    }
    // Schreibweise vereinheitlicht (häufigste gewinnt), Leerraum weg – inhaltlich dieselbe Angabe
    expect(place(byId.get("X1")!)).toBe("Hauptgebäude, EG");
    expect(byId.get("X1")!.floor_id).toBe(byId.get("101")!.floor_id);
    // Etage ohne Gebäude → Sammelgebäude „Ohne Gebäude“ (bisherige Überschrift der Raumliste)
    expect(place(byId.get("X2")!)).toBe("Ohne Gebäude, UG");
    // leere Angaben bleiben leer
    expect(byId.get("X3")).toMatchObject({ building: null, floor: null, building_id: null, floor_id: null });
    // stillgelegte Räume werden mit übernommen
    expect(place(byId.get("ALT")!)).toBe("Altbau, Dachgeschoss");

    // Stammdaten: Gebäude alphabetisch, „Ohne Gebäude“ am Ende; Etagen UG/EG/1. OG/2. OG/Dach
    const list = await listBuildings(h.db);
    expect(list.map((b) => b.name)).toEqual(["Altbau", "Hauptgebäude", "Naturwissenschaften", "Pavillon", "Sporthalle", "Ohne Gebäude"]);
    expect(list.find((b) => b.name === "Hauptgebäude")!.floors.map((f) => [f.name, f.rooms])).toEqual([
      ["EG", 15],
      ["1. OG", 13],
      ["2. OG", 6],
    ]);
    expect(list.find((b) => b.name === "Naturwissenschaften")!.floors.map((f) => f.name)).toEqual(["EG", "1. OG"]);

    // Raumfinder (aktive Räume): dieselben Gruppen in derselben Reihenfolge wie vorher, danach die Sonderfälle
    const dir = await roomDirectory(h.db);
    const groups = [...new Set(dir.map((r) => r.building ?? "Ohne Gebäude"))];
    expect(groups.filter((g) => demoGroupsBefore.includes(g))).toEqual(demoGroupsBefore);
    expect(groups).toEqual([...demoGroupsBefore, "Ohne Gebäude"]);
    // innerhalb des Hauptgebäudes jetzt nach Etage (EG vor 1. OG), vorher nur nach Kürzel – die Kürzel 1xx liegen im EG
    expect(dir.filter((r) => r.building === "Hauptgebäude").map((r) => r.floor)).toEqual([...dir.filter((r) => r.building === "Hauptgebäude").map((r) => r.floor)].sort((a, b) => ["EG", "1. OG", "2. OG"].indexOf(a!) - ["EG", "1. OG", "2. OG"].indexOf(b!)));
  });
});
