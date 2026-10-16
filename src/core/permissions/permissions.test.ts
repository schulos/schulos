import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { grants, groupMembers, groups, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import {
  accessBlocked,
  assertPermission,
  can,
  ForbiddenError,
  grantCovers,
  hasPermission,
  loadPermissions,
  requiresTwoFactor,
  type PermissionSet,
} from "./index";

function set(over: Partial<PermissionSet> = {}): PermissionSet {
  return {
    userId: "u",
    role: "schueler",
    locked: false,
    granted: new Set(),
    memberOf: new Set(),
    leaderOf: new Set(),
    ...over,
  };
}

describe("grantCovers", () => {
  it.each([
    ["news.write", "news.write", true],
    ["news.write", "news.read", false],
    ["news.*", "news.write", true],
    ["news.*", "newsletter.write", false],
    ["*", "irgendwas.tun", true],
    ["news", "news.write", false],
  ])("%s deckt %s ab → %s", (pattern, perm, expected) => {
    expect(grantCovers(pattern, perm)).toBe(expected);
  });
});

describe("accessBlocked (B-55: gilt auch für /api)", () => {
  it("gesperrt vor Startpasswort vor Pflicht-2FA; sonst frei – auch mit Rechten", () => {
    expect(accessBlocked(set({ granted: new Set(["verwaltung.privacy"]) }))).toBeNull();
    expect(accessBlocked(set({ twoFactorPending: true, granted: new Set(["verwaltung.privacy"]) }))).toBe("zwei-faktor");
    expect(accessBlocked(set({ passwordChangePending: true, twoFactorPending: true }))).toBe("passwort");
    expect(accessBlocked(set({ locked: true, passwordChangePending: true }))).toBe("gesperrt");
  });
});

describe("requiresTwoFactor (Rolle Personal, P4-10)", () => {
  it("Personal wie Lehrkräfte: Pflicht nur mit Verwaltungsrechten (Pflicht für alle Erwachsenen kommt mit SEC-01)", () => {
    expect(requiresTwoFactor("personal", [])).toBe(false);
    expect(requiresTwoFactor("personal", ["gebaeude.manage"])).toBe(false);
    expect(requiresTwoFactor("lehrkraft", ["gebaeude.report"])).toBe(false);
    expect(requiresTwoFactor("personal", ["verwaltung.access"])).toBe(true);
    expect(requiresTwoFactor("verwaltung", [])).toBe(true);
  });

  it("Beratung (Schulsozialarbeit, Q5-17): Pflicht sofort, ohne Verwaltungsrechte", () => {
    expect(requiresTwoFactor("beratung", [])).toBe(true);
  });

  it("Personal bekommt Rechte über Gruppen, nicht über Rollen anderer", () => {
    const hausmeister = set({ role: "personal", granted: new Set(["gebaeude.report", "gebaeude.manage"]) });
    expect(hasPermission(hausmeister, "gebaeude.manage")).toBe(true);
    expect(hasPermission(hausmeister, "klassenbuch.view_all")).toBe(false);
    expect(hasPermission(hausmeister, "verwaltung.access")).toBe(false);
  });
});

describe("hasPermission (rein)", () => {
  it("verweigert ohne Grant", () => {
    expect(hasPermission(set(), "news.write")).toBe(false);
  });
  it("erlaubt mit direktem Grant", () => {
    expect(hasPermission(set({ granted: new Set(["news.write"]) }), "news.write")).toBe(true);
  });
  it("erlaubt über Wildcard", () => {
    expect(hasPermission(set({ granted: new Set(["aufgaben.*"]) }), "aufgaben.create")).toBe(true);
  });
  it("Admin darf alles", () => {
    expect(hasPermission(set({ role: "admin" }), "verwaltung.users.delete")).toBe(true);
  });
  it("gesperrter Admin darf nichts", () => {
    expect(hasPermission(set({ role: "admin", locked: true }), "news.read")).toBe(false);
  });
  it("gesperrter Benutzer verliert auch explizite Grants", () => {
    expect(hasPermission(set({ locked: true, granted: new Set(["news.write"]) }), "news.write")).toBe(false);
  });
  it("Gruppenleitung bekommt group.*-Rechte für ihre Gruppe", () => {
    const s = set({ leaderOf: new Set(["g1"]) });
    expect(hasPermission(s, "group.manage_members", { groupId: "g1" })).toBe(true);
  });
  it("Gruppenleitung gilt nicht für fremde Gruppen", () => {
    const s = set({ leaderOf: new Set(["g1"]) });
    expect(hasPermission(s, "group.manage_members", { groupId: "g2" })).toBe(false);
  });
  it("Gruppenleitung gilt nicht ohne Gruppenkontext", () => {
    expect(hasPermission(set({ leaderOf: new Set(["g1"]) }), "group.manage_members")).toBe(false);
  });
  it("Gruppenleitung gibt keine Nicht-group-Rechte", () => {
    expect(hasPermission(set({ leaderOf: new Set(["g1"]) }), "news.write", { groupId: "g1" })).toBe(false);
  });
  it("assertPermission wirft ForbiddenError", () => {
    expect(() => assertPermission(set(), "news.write")).toThrow(ForbiddenError);
  });
});

describe("loadPermissions / can (DB)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values([
      { id: "lk", name: "Lehrkraft", email: "lk@t", role: "lehrkraft" },
      { id: "sv", name: "Schülervertretung", email: "sv@t", role: "schueler" },
      { id: "s", name: "Schüler", email: "s@t", role: "schueler" },
      { id: "x", name: "Gesperrt", email: "x@t", role: "lehrkraft", status: "locked" },
    ]);
    await h.db.insert(groups).values([
      { id: "g-sv", name: "Schülervertretung", slug: "sv", kind: "gremium" },
      { id: "g-7b", name: "Klasse 7b", slug: "7b", kind: "klasse" },
    ]);
    await h.db.insert(groupMembers).values([
      { groupId: "g-sv", userId: "sv" },
      { groupId: "g-7b", userId: "lk", role: "leader" },
      { groupId: "g-7b", userId: "s" },
    ]);
    await h.db.insert(grants).values([
      { permission: "aufgaben.create", role: "lehrkraft" },
      { permission: "news.write", groupId: "g-sv" },
    ]);
  });
  afterAll(() => h.close());

  it("Rollen-Grant greift", async () => {
    expect(await can(h.db, "lk", "aufgaben.create")).toBe(true);
  });
  it("Rollen-Grant greift nicht für andere Rollen", async () => {
    expect(await can(h.db, "s", "aufgaben.create")).toBe(false);
  });
  it("Gruppen-Grant greift für Mitglieder", async () => {
    expect(await can(h.db, "sv", "news.write")).toBe(true);
  });
  it("Gruppen-Grant greift nicht für Nicht-Mitglieder", async () => {
    expect(await can(h.db, "s", "news.write")).toBe(false);
  });
  it("Klassenleitung darf ihre Klasse verwalten", async () => {
    expect(await can(h.db, "lk", "group.manage_members", { groupId: "g-7b" })).toBe(true);
    expect(await can(h.db, "s", "group.manage_members", { groupId: "g-7b" })).toBe(false);
  });
  it("gesperrte Lehrkraft verliert ihren Rollen-Grant", async () => {
    expect(await can(h.db, "x", "aufgaben.create")).toBe(false);
  });
  it("lädt Mitgliedschaften", async () => {
    const p = await loadPermissions(h.db, "lk");
    expect([...p.memberOf]).toEqual(["g-7b"]);
    expect([...p.leaderOf]).toEqual(["g-7b"]);
  });
  it("wirft bei unbekanntem Benutzer", async () => {
    await expect(loadPermissions(h.db, "gibtsnicht")).rejects.toThrow();
  });
});
