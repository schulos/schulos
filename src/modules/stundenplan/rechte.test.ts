// SP-02: Planungsrechte – Migration 0088 (Upgrade ohne Rechteverlust, idempotent), Funktionsgruppe, Vorgaben, 2FA, Demo, SEC-04.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, DbHandle } from "@/core/db/client";
import { appSettings, grants, groupMembers, groups, schoolYears, timetableReductions, users } from "@/core/db/schema";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { syncDefaultGrants } from "@/core/modules/registry";
import { hasPermission, loadPermissions } from "@/core/permissions";
import { MODULES } from "@/modules";
import { addMembers } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { addReduction, REDUCTION_LABELS, reductionKind } from "./deputate";
import manifest from "./manifest";
import { PLAN_MANAGE, PLAN_SUBSTITUTE, PLANNING_GROUP } from "./rechte";

/** Daten-Teil der Migration 0088 (ohne den Enum-Wert, den die Test-DB schon hat) – simuliert das Update einer Bestandsinstallation. */
async function runDataMigration(db: Db) {
  const file = readFileSync(join(process.cwd(), "drizzle", "0088_stundenplanung.sql"), "utf8");
  const statements = file
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s && !/^(--[^\n]*\n)*ALTER TYPE/.test(s));
  expect(statements).toHaveLength(3);
  for (const s of statements) await db.execute(sql.raw(s));
}

const grantsOf = async (db: Db, target: { role?: "verwaltung" | "lehrkraft"; groupId?: string }) =>
  (
    await db
      .select({ p: grants.permission })
      .from(grants)
      .where(target.role ? eq(grants.role, target.role) : eq(grants.groupId, target.groupId!))
  )
    .map((r) => r.p)
    .filter((p) => p.startsWith("stundenplan."))
    .sort();

describe("Planungsrechte (SP-02)", () => {
  it("Manifest: zwei Rechte, keine Rollen-Vorgabe mehr (Q-SP-3)", () => {
    expect(Object.keys(manifest.permissions ?? {})).toEqual(expect.arrayContaining([PLAN_MANAGE, PLAN_SUBSTITUTE, "stundenplan.absence_approve"]));
    expect(manifest.defaultGrants ?? {}).toEqual({});
  });

  describe("neue Installation", () => {
    let h: DbHandle;
    beforeAll(async () => {
      h = await createTestDb();
      await syncDefaultGrants(h.db, MODULES);
    }, 60_000);
    afterAll(() => h.close());

    it("Funktionsgruppe mit beiden Rechten, ohne Mitglieder; keine Rolle plant per Vorgabe", async () => {
      const [g] = await h.db.select().from(groups).where(eq(groups.id, PLANNING_GROUP.id));
      expect(g).toMatchObject({ name: "Stundenplanung", slug: "stundenplanung", kind: "gremium" });
      expect(await grantsOf(h.db, { groupId: PLANNING_GROUP.id })).toEqual([PLAN_MANAGE, PLAN_SUBSTITUTE]);
      expect(await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, PLANNING_GROUP.id))).toEqual([]);
      expect(await grantsOf(h.db, { role: "verwaltung" })).toEqual([]);
    });
  });

  describe("Update einer Bestandsinstallation (Migration 0088)", () => {
    let h: DbHandle;
    beforeAll(async () => {
      h = await createTestDb();
      // Stand vor 0088: keine Funktionsgruppe, Vorgabe verwaltung → manage (gesynct), eine eigene Planungsgruppe der Schule
      await h.db.delete(groups).where(eq(groups.id, PLANNING_GROUP.id));
      await h.db.insert(grants).values({ role: "verwaltung", permission: PLAN_MANAGE });
      await h.db.insert(appSettings).values({ key: "grants.synced.stundenplan", value: ["verwaltung:stundenplan.manage"] });
      await h.db.insert(groups).values({ id: "g-planer", name: "Planer", slug: "planer", kind: "frei" });
      await h.db.insert(grants).values({ groupId: "g-planer", permission: PLAN_MANAGE });
      await h.db.insert(grants).values({ groupId: "g-planer", permission: "stundenplan.absence_approve" });
    }, 60_000);
    afterAll(() => h.close());

    it("wer planen durfte, darf auch vertreten; Rollen-Grant bleibt; Gruppe kommt dazu – auch beim zweiten Lauf nichts doppelt", async () => {
      await runDataMigration(h.db);
      await runDataMigration(h.db); // idempotent
      expect(await grantsOf(h.db, { role: "verwaltung" })).toEqual([PLAN_MANAGE, PLAN_SUBSTITUTE]);
      expect(await grantsOf(h.db, { groupId: "g-planer" })).toEqual(["stundenplan.absence_approve", PLAN_MANAGE, PLAN_SUBSTITUTE]);
      expect(await grantsOf(h.db, { groupId: PLANNING_GROUP.id })).toEqual([PLAN_MANAGE, PLAN_SUBSTITUTE]);
      expect(await h.db.select().from(groups).where(eq(groups.slug, "stundenplanung"))).toHaveLength(1);
    });

    it("Serverstart danach: entzogener Rollen-Grant kommt nicht wieder (grants.synced behält das Paar)", async () => {
      await h.db.delete(grants).where(and(eq(grants.role, "verwaltung"), eq(grants.permission, PLAN_MANAGE)));
      await syncDefaultGrants(h.db, MODULES);
      expect(await grantsOf(h.db, { role: "verwaltung" })).toEqual([PLAN_SUBSTITUTE]);
      const [synced] = await h.db.select().from(appSettings).where(eq(appSettings.key, "grants.synced.stundenplan"));
      expect(synced?.value).toEqual(["verwaltung:stundenplan.manage"]);
    });

    it("eine schon vorhandene Gruppe „stundenplanung“ der Schule bekommt keine Rechte und keine zweite Gruppe entsteht", async () => {
      const db = await createTestDb();
      try {
        await db.db.delete(groups).where(eq(groups.id, PLANNING_GROUP.id));
        await db.db.insert(groups).values({ id: "g-eigene", name: "Stundenplanung (eigene)", slug: "stundenplanung", kind: "frei" });
        await runDataMigration(db.db);
        expect(await db.db.select({ id: groups.id }).from(groups).where(eq(groups.slug, "stundenplanung"))).toEqual([{ id: "g-eigene" }]);
        expect(await grantsOf(db.db, { groupId: "g-eigene" })).toEqual([]);
        expect(await db.db.select().from(grants).where(and(eq(grants.groupId, PLANNING_GROUP.id), isNull(grants.role)))).toEqual([]);
      } finally {
        await db.close();
      }
    });
  });

  describe("Demo-Schule (Q-SP-8)", () => {
    let h: DbHandle;
    beforeAll(async () => {
      h = await createSeededTestDb();
    }, 60_000);
    afterAll(() => h.close());

    it("frank.schulte leitet die Gruppe Stundenplanung und hat beide Rechte; Schulleitung nur Vertretung", async () => {
      const [m] = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, PLANNING_GROUP.id));
      expect(m).toMatchObject({ userId: "u-frank.schulte", role: "leader" });
      const frank = await loadPermissions(h.db, "u-frank.schulte");
      expect(frank.role).toBe("lehrkraft");
      expect(hasPermission(frank, PLAN_MANAGE)).toBe(true);
      expect(hasPermission(frank, PLAN_SUBSTITUTE)).toBe(true);
      expect(hasPermission(frank, "verwaltung.access")).toBe(false);
      // Demo-Instanzen erzwingen 2FA nicht – sonst wäre Frank jetzt gesperrt (Q-SP-5)
      expect(frank.twoFactorPending).toBe(false);
      const lindner = await loadPermissions(h.db, "u-petra.lindner");
      expect(hasPermission(lindner, PLAN_SUBSTITUTE)).toBe(true);
      expect(hasPermission(lindner, PLAN_MANAGE)).toBe(false);
      const jana = await loadPermissions(h.db, "u-jana.brandt");
      expect(hasPermission(jana, PLAN_MANAGE) || hasPermission(jana, PLAN_SUBSTITUTE)).toBe(false);
      // SP-03: das Sekretariat plant in der Demo nicht mehr (kein Rollen-Grant für `verwaltung`)
      const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
      expect(hasPermission(sabine, PLAN_MANAGE) || hasPermission(sabine, PLAN_SUBSTITUTE)).toBe(false);
      const verwaltung = await grantsOf(h.db, { role: "verwaltung" });
      expect(verwaltung).not.toContain(PLAN_MANAGE);
      expect(verwaltung).not.toContain(PLAN_SUBSTITUTE);
    });

    it("SEC-04: Mitglieder der Funktionsgruppe nimmt nur auf, wer beide Rechte selbst hat", async () => {
      const err = await addMembers(h.db, "u-petra.lindner", PLANNING_GROUP.id, ["u-jana.brandt"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(await addMembers(h.db, "u-admin", PLANNING_GROUP.id, ["u-jana.brandt"])).toBe(1);
      const jana = await loadPermissions(h.db, "u-jana.brandt");
      expect(hasPermission(jana, PLAN_MANAGE)).toBe(true);
    });

    it("Anrechnungsgrund „Stundenplanung“ im Deputat (Projektleitung 2026-10-19)", async () => {
      expect(REDUCTION_LABELS.stundenplanung).toBe("Stundenplanung");
      expect(reductionKind("stundenplanung")).toBe("Anrechnung");
      const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).orderBy(desc(schoolYears.startsOn)).limit(1);
      const id = await addReduction(h.db, "u-admin", { schoolYearId: year!.id, teacherId: "u-frank.schulte", reason: "stundenplanung", hours: 3, note: null });
      const [row] = await h.db.select({ reason: timetableReductions.reason }).from(timetableReductions).where(eq(timetableReductions.id, id));
      expect(row?.reason).toBe("stundenplanung");
    });
  });

  it("2FA sofort für Planende außerhalb einer Demo (Q-SP-5)", async () => {
    const h = await createTestDb();
    try {
      await h.db.insert(users).values({ id: "u-plan", name: "Pia Plan", username: "pia.plan", email: "pia@example.test", role: "lehrkraft" });
      await h.db.insert(groupMembers).values({ groupId: PLANNING_GROUP.id, userId: "u-plan" });
      const p = await loadPermissions(h.db, "u-plan");
      expect(p.twoFactorPending).toBe(true);
      expect(hasPermission(p, PLAN_MANAGE)).toBe(false); // bis 2FA eingerichtet ist
    } finally {
      await h.close();
    }
  });
});

describe("Kurswahl lesen für die Funktionsgruppe (SP-05, Migration 0091)", () => {
  const migration0091 = () => readFileSync(join(process.cwd(), "drizzle", "0091_kurswahl_lesen.sql"), "utf8");
  const viewGrants = async (db: Db) =>
    (await db.select({ g: grants.groupId, r: grants.role }).from(grants).where(eq(grants.permission, "kurswahl.view"))).map((x) => x.g ?? `rolle:${x.r}`).sort();

  it("neue Installation: nur die Funktionsgruppe bekommt `kurswahl.view`; erneuter Lauf ändert nichts", async () => {
    const h = await createTestDb();
    try {
      expect(await viewGrants(h.db)).toEqual([PLANNING_GROUP.id]);
      const before = await h.db.select({ n: sql<number>`count(*)` }).from(grants);
      await h.db.execute(sql.raw(migration0091()));
      expect(await viewGrants(h.db)).toEqual([PLANNING_GROUP.id]);
      expect(await h.db.select({ n: sql<number>`count(*)` }).from(grants)).toEqual(before);
    } finally {
      await h.close();
    }
  });

  it("eine eigene Gruppe „stundenplanung“ der Schule (andere ID) bekommt kein Recht", async () => {
    const h = await createTestDb();
    try {
      await h.db.delete(grants).where(eq(grants.permission, "kurswahl.view"));
      await h.db.delete(groups).where(eq(groups.id, PLANNING_GROUP.id));
      await h.db.insert(groups).values({ id: "g-eigene", name: "Stundenplanung (eigene)", slug: "stundenplanung", kind: "frei" });
      await h.db.execute(sql.raw(migration0091()));
      expect(await viewGrants(h.db)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("Demo: frank.schulte liest Kurswahlen, verwaltet sie aber nicht", async () => {
    const h = await createSeededTestDb();
    try {
      const frank = await loadPermissions(h.db, "u-frank.schulte");
      expect(hasPermission(frank, "kurswahl.view")).toBe(true);
      expect(hasPermission(frank, "kurswahl.manage")).toBe(false);
    } finally {
      await h.close();
    }
  }, 60_000);
});
