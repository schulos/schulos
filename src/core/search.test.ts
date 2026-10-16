import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { MODULES } from "@/modules";
import { SEARCH_PROVIDERS } from "@/modules/search";
import { globalSearch, type SearchProvider } from "./search";

describe("globale Suche", () => {
  let h: DbHandle;
  let lea: CurrentUser;
  beforeAll(async () => {
    h = await createSeededTestDb();
    lea = { user: { id: "u-lea.schaefer", name: "Lea Schäfer", firstName: "Lea", lastName: "Schäfer", shortCode: null, role: "schueler", username: "lea.schaefer" }, perms: await loadPermissions(h.db, "u-lea.schaefer") };
  }, 60_000);
  afterAll(() => h.close());

  it("findet Personen und Gruppen über das Adressbuch", async () => {
    const hits = await globalSearch(h.db, lea, "brandt", SEARCH_PROVIDERS, MODULES, new Map());
    expect(hits[0]).toMatchObject({ group: "Personen", title: "Jana Brandt", href: "/adressbuch/person/u-jana.brandt", avatar: "BRA" });
    const groups = await globalSearch(h.db, lea, "7b", SEARCH_PROVIDERS, MODULES, new Map());
    expect(groups.some((g) => g.group === "Gruppen" && g.title === "Klasse 7b")).toBe(true);
  });

  it("ignoriert zu kurze Anfragen und abgeschaltete Module", async () => {
    expect(await globalSearch(h.db, lea, "b", SEARCH_PROVIDERS, MODULES, new Map())).toEqual([]);
    expect(await globalSearch(h.db, lea, "brandt", SEARCH_PROVIDERS, MODULES, new Map([["adressbuch", false]]))).toEqual([]);
  });

  it("ein kaputter Provider legt die Suche nicht lahm", async () => {
    const broken: SearchProvider = { moduleId: "heute", search: async () => { throw new Error("kaputt"); } };
    const orig = console.error;
    console.error = () => {};
    const hits = await globalSearch(h.db, lea, "brandt", [broken, ...SEARCH_PROVIDERS], MODULES, new Map());
    console.error = orig;
    expect(hits.length).toBeGreaterThan(0);
  });
});
