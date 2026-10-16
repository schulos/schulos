import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserWithPassword } from "@/core/auth/auth";
import { listUsers } from "@/modules/verwaltung/users";
import type { DbHandle } from "./client";
import { createTestDb } from "./testing";

// TD-01: Namenslisten deutsch sortiert (DIN 5007-1) – PGlite und PostgreSQL 18 (npm run test:pg)
describe("Deutsche Sortierung (TD-01)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    const names = [
      ["Zoe", "Zander"],
      ["Ömer", "Özdemir"],
      ["Otto", "Oberle"],
      ["Anna", "abel"],
      ["Ärzu", "Äbi"],
      ["Jan", "de Vries"],
      ["Mia", "Müller"],
      ["Max", "Mueller"],
    ];
    for (const [i, [first, last]] of names.entries())
      await createUserWithPassword(h.db, { id: `u${i}`, name: `${first} ${last}`, firstName: first, lastName: last, username: `u${i}`, role: "eltern" }, { hash: "x" });
  });
  afterAll(() => h.close());

  it("sortiert Umlaute beim Grundbuchstaben und Groß-/Kleinschreibung nachrangig (Benutzerverwaltung)", async () => {
    const { rows } = await listUsers(h.db, { role: "eltern" });
    expect(rows.map((r) => r.lastName)).toEqual(["abel", "Äbi", "de Vries", "Mueller", "Müller", "Oberle", "Özdemir", "Zander"]);
    // dieselbe Reihenfolge wie Intl.Collator("de") in der Oberfläche
    const collator = new Intl.Collator("de");
    expect(rows.map((r) => r.lastName)).toEqual(rows.map((r) => r.lastName).sort(collator.compare));
  });
});
