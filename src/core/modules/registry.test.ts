import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { grants, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { MODULES } from "@/modules";
import {
  allPermissions,
  buildNav,
  isEnabled,
  loadModuleStates,
  setModuleEnabled,
  syncDefaultGrants,
  syncModules,
  validateManifests,
} from "./registry";
import { defineModule } from "./types";

const dummy = defineModule({
  id: "dummy",
  name: "Dummy",
  description: "Testmodul",
  icon: "Box",
  section: "unterricht",
  permissions: { "dummy.use": "Benutzen", "dummy.admin": "Verwalten" },
  defaultGrants: { lehrkraft: ["dummy.use"] },
  nav: [
    { href: "/dummy", label: "Dummy" },
    { href: "/dummy/admin", label: "Dummy-Admin", requires: "dummy.admin" },
    { href: "/dummy/lk", label: "Nur Lehrkräfte", roles: ["lehrkraft"] },
  ],
});
const core = defineModule({ id: "kern", name: "Kern", description: "", icon: "Box", section: "start", core: true, nav: [{ href: "/", label: "Start" }] });
const off = defineModule({ id: "aus", name: "Aus", description: "", icon: "Box", section: "organisation", defaultEnabled: false, nav: [{ href: "/aus", label: "Aus" }] });

const student: PermissionSet = { userId: "s", role: "schueler", locked: false, granted: new Set(), memberOf: new Set(), leaderOf: new Set() };

describe("validateManifests", () => {
  it("akzeptiert die echten Module", () => {
    expect(() => validateManifests(MODULES)).not.toThrow();
  });
  it("findet doppelte ids, falsche Präfixe und undeklarierte defaultGrants", () => {
    const bad = [
      dummy,
      { ...dummy },
      defineModule({ id: "x", name: "X", description: "", icon: "Box", section: "start", permissions: { "y.do": "" }, defaultGrants: { admin: ["x.nope"] } }),
    ];
    expect(() => validateManifests(bad)).toThrow(/doppelte id[\s\S]*muss mit "x\." beginnen[\s\S]*nicht deklariert/);
  });
  it("prüft Schlüssel und Vorgaben der Moduleinstellungen (Q5-14)", () => {
    const bad = defineModule({
      id: "z",
      name: "Z",
      description: "",
      icon: "Box",
      section: "start",
      settings: [
        { key: "y.mode", label: "", options: [{ value: "a", label: "A" }], default: "a" },
        { key: "z.mode", label: "", options: [{ value: "a", label: "A" }], default: "b" },
      ],
    });
    expect(() => validateManifests([bad])).toThrow(/Einstellung "y\.mode" muss mit "z\." beginnen[\s\S]*Vorgabe von "z\.mode" ist keine Option/);
  });

  it("Löschregeln mit Moduleinstellung (Q5-26): Einstellung muss existieren und Zahlen liefern", () => {
    const rule = { table: "z_t", purpose: "x", categories: ["x"], class: "LK-1J" as const, start: "created_at", where: "n >= {setting}" };
    const bad = defineModule({
      id: "z",
      name: "Z",
      description: "",
      icon: "Box",
      section: "start",
      settings: [{ key: "z.text", label: "", options: [{ value: "a", label: "A" }], default: "a" }],
      retention: [
        { ...rule, setting: "z.fehlt" },
        { ...rule, scope: "2", setting: "z.text" },
      ],
    });
    expect(() => validateManifests([bad])).toThrow(/unbekannte Einstellung "z\.fehlt"[\s\S]*"z\.text" für das Löschkonzept braucht Zahlenwerte/);
  });
});

describe("buildNav", () => {
  it("zeigt aktive Module gruppiert nach Sektion", () => {
    const nav = buildNav([dummy, core, off], new Map(), student);
    expect(nav.map((g) => g.section)).toEqual(["start", "unterricht"]);
    expect(nav[1]?.label).toBe("Unterricht");
  });
  it("blendet Einträge ohne Recht oder mit falscher Rolle aus", () => {
    const items = buildNav([dummy], new Map(), student)[0]!.items.map((i) => i.label);
    expect(items).toEqual(["Dummy"]);
  });
  it("zeigt Einträge, wenn Recht und Rolle passen", () => {
    const lk = { ...student, role: "lehrkraft" as const, granted: new Set(["dummy.*"]) };
    expect(buildNav([dummy], new Map(), lk)[0]!.items).toHaveLength(3);
  });
  it("G4D-C09: eigenständige Schüler:innen sehen Elternbriefe und Elternsprechtag, andere Schüler:innen nicht", () => {
    const hrefs = (self: boolean) => buildNav(MODULES, new Map(), student, { selfResponsible: self }).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(false)).not.toContain("/elternbriefe");
    expect(hrefs(false)).not.toContain("/sprechtag/buchen");
    expect(hrefs(true)).toEqual(expect.arrayContaining(["/elternbriefe", "/sprechtag/buchen"]));
    // das Kennzeichen wirkt nur für die Rolle Schüler:in
    const parent = { ...student, role: "eltern" as const };
    expect(buildNav(MODULES, new Map(), parent, { selfResponsible: true }).flatMap((g) => g.items.map((i) => i.href)).filter((h) => h === "/elternbriefe")).toHaveLength(1);
  });
  it("Hausmeisterei (Rolle Personal mit gebaeude.manage) sieht die Raumbelegung, Personal ohne das Recht nicht (Q5-08)", () => {
    const hrefs = (perms: PermissionSet) => buildNav(MODULES, new Map(), perms).flatMap((g) => g.items.map((i) => i.href));
    const hausmeister = { ...student, role: "personal" as const, granted: new Set(["gebaeude.report", "gebaeude.manage"]) };
    expect(hrefs(hausmeister).filter((h) => h === "/stundenplan/raeume")).toHaveLength(1);
    expect(hrefs({ ...hausmeister, granted: new Set(["gebaeude.report"]) })).not.toContain("/stundenplan/raeume");
    // Lehrkraft mit Verwaltungsrecht: weiterhin genau ein Eintrag
    const verwaltung = { ...student, role: "verwaltung" as const, granted: new Set(["gebaeude.manage"]) };
    expect(hrefs(verwaltung).filter((h) => h === "/stundenplan/raeume")).toHaveLength(1);
    // Gebäude-Modul aus: kein Eintrag für die Hausmeisterei (Security-Review Gate 4a Hinweis 4)
    const offStates = new Map([["gebaeude", false]]);
    expect(buildNav(MODULES, offStates, hausmeister).flatMap((g) => g.items.map((i) => i.href))).not.toContain("/stundenplan/raeume");
  });
  it("Hausmeisterei sieht „Buchungen“ (nur lesen) nur mit gebaeude.manage und Gebäude-Modul (Q5-08b)", () => {
    const hrefs = (perms: PermissionSet, states = new Map<string, boolean>()) => buildNav(MODULES, states, perms).flatMap((g) => g.items.map((i) => i.href));
    const hausmeister = { ...student, role: "personal" as const, granted: new Set(["gebaeude.report", "gebaeude.manage"]) };
    expect(hrefs(hausmeister).filter((h) => h === "/buchungen")).toHaveLength(1);
    expect(hrefs({ ...hausmeister, granted: new Set(["gebaeude.report"]) })).not.toContain("/buchungen");
    expect(hrefs(hausmeister, new Map([["gebaeude", false]]))).not.toContain("/buchungen");
    expect(hrefs({ ...student, role: "lehrkraft" as const, granted: new Set(["buchungen.book"]) }).filter((h) => h === "/buchungen")).toHaveLength(1);
  });
  it("Gebäude & Technik auch für „lesen“ bzw. „einrichten“ ohne Melderecht (Code-Review Gate 4a N5)", () => {
    const hrefs = (granted: string[]) => buildNav(MODULES, new Map(), { ...student, role: "verwaltung", granted: new Set(granted) }).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(["gebaeude.view_all"])).toContain("/gebaeude");
    expect(hrefs(["gebaeude.configure"])).toContain("/gebaeude");
    expect(hrefs([])).not.toContain("/gebaeude");
  });
  it("blendet abgeschaltete Module aus, Kernmodule nie", () => {
    const states = new Map([["dummy", false], ["kern", false], ["aus", true]]);
    expect(buildNav([dummy, core, off], states, student).flatMap((g) => g.items.map((i) => i.moduleId))).toEqual(["kern", "aus"]);
  });
});

describe("Registry mit DB", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "lk", name: "LK", email: "lk@t", role: "lehrkraft" });
  });
  afterAll(() => h.close());

  it("schaltet ein Modul ab und wieder an", async () => {
    await setModuleEnabled(h.db, dummy, false);
    expect(isEnabled(dummy, await loadModuleStates(h.db))).toBe(false);
    await setModuleEnabled(h.db, dummy, true);
    expect(isEnabled(dummy, await loadModuleStates(h.db))).toBe(true);
  });
  it("verweigert das Abschalten von Kernmodulen", async () => {
    await expect(setModuleEnabled(h.db, core, false)).rejects.toThrow(/Kernmodul/);
  });
  it("legt defaultGrants genau einmal an", async () => {
    expect(await syncDefaultGrants(h.db, [dummy])).toEqual(["dummy"]);
    expect((await loadPermissions(h.db, "lk")).granted.has("dummy.use")).toBe(true);
    await h.db.delete(grants); // Admin entfernt den Grant bewusst
    expect(await syncDefaultGrants(h.db, [dummy])).toEqual([]);
    expect((await loadPermissions(h.db, "lk")).granted.size).toBe(0);
  });
  it("neues Recht in einem bestehenden Modul wird nachgetragen, Entzogenes bleibt entzogen", async () => {
    const v2 = { ...dummy, permissions: { ...dummy.permissions, "dummy.extra": "Extra" }, defaultGrants: { lehrkraft: ["dummy.use", "dummy.extra"] } };
    expect(await syncDefaultGrants(h.db, [v2])).toEqual(["dummy"]);
    const granted = (await loadPermissions(h.db, "lk")).granted;
    expect(granted.has("dummy.extra")).toBe(true);
    expect(granted.has("dummy.use")).toBe(false); // wurde oben bewusst entfernt
    expect(await syncDefaultGrants(h.db, [v2])).toEqual([]);
  });
    it("listet alle Rechte mit Modulnamen", () => {
    expect(allPermissions([dummy]).map((p) => p.id)).toEqual(["dummy.use", "dummy.admin"]);
  });
});

describe("syncModules (neue Module nach einem Update)", () => {
  it("erster Lauf merkt sich alle Module; danach kommen neue ausgeschaltet, mit Standardrechten; Admin-Entscheidungen bleiben", async () => {
    const h = await createTestDb();
    try {
      // Stand vor dem Update: nur dummy + kern
      expect(await syncModules(h.db, [core, dummy])).toEqual({ newlyDisabled: [] });
      expect(isEnabled(dummy, await loadModuleStates(h.db))).toBe(true);

      // Update bringt „neu“ (Vorgabe an) und „aus“ (Vorgabe aus) mit
      const neu = defineModule({ id: "neu", name: "Neu", description: "", icon: "Box", section: "unterricht", permissions: { "neu.use": "Benutzen" }, defaultGrants: { lehrkraft: ["neu.use"] }, nav: [{ href: "/neu", label: "Neu" }] });
      expect(await syncModules(h.db, [core, dummy, neu, off])).toEqual({ newlyDisabled: ["neu", "aus"] });
      const states = await loadModuleStates(h.db);
      expect(isEnabled(neu, states)).toBe(false);
      expect(isEnabled(dummy, states)).toBe(true);
      expect((await h.db.select().from(grants)).map((g) => `${g.role}:${g.permission}`)).toContain("lehrkraft:neu.use");

      // Admin schaltet ein – der nächste Start lässt das so
      await setModuleEnabled(h.db, neu, true);
      expect(await syncModules(h.db, [core, dummy, neu, off])).toEqual({ newlyDisabled: [] });
      expect(isEnabled(neu, await loadModuleStates(h.db))).toBe(true);
    } finally {
      await h.close();
    }
  });
});
