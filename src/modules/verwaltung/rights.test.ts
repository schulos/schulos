import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, groupMembers } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { STUDENT_DIRECT } from "@/modules/messenger/settings";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { can } from "@/core/permissions";
import { MODULES } from "@/modules";
import {
  addGroupGrant,
  getRoleGrantMatrix,
  grantablePermissions,
  listGroupGrants,
  removeGrant,
  setModuleSetting,
  setRoleGrant,
  toggleModule,
} from "./rights";
import { ValidationError } from "./users";

const ADMIN = "u-admin";

describe("Rechteverwaltung", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("bietet Modulrechte plus Wildcards an", () => {
    const ids = grantablePermissions(MODULES).map((p) => p.id);
    expect(ids).toContain("verwaltung.users");
    expect(ids).toContain("verwaltung.*");
  });

  it("Matrix enthält die Default-Grants des Seeds", async () => {
    const m = await getRoleGrantMatrix(h.db);
    expect(m.has("verwaltung:verwaltung.users")).toBe(true);
    expect(m.has("lehrkraft:verwaltung.users")).toBe(false);
  });

  it("Rollen-Grant setzen und entziehen wirkt sofort", async () => {
    await setRoleGrant(h.db, MODULES, ADMIN, "lehrkraft", "verwaltung.access", true);
    expect(await can(h.db, "u-jana.brandt", "verwaltung.access")).toBe(true);
    await setRoleGrant(h.db, MODULES, ADMIN, "lehrkraft", "verwaltung.access", true); // idempotent
    await setRoleGrant(h.db, MODULES, ADMIN, "lehrkraft", "verwaltung.access", false);
    expect(await can(h.db, "u-jana.brandt", "verwaltung.access")).toBe(false);
  });

  it("lehnt unbekannte Rechte und Admin-Änderungen ab", async () => {
    await expect(setRoleGrant(h.db, MODULES, ADMIN, "lehrkraft", "gibts.nicht", true)).rejects.toThrow(ValidationError);
    await expect(setRoleGrant(h.db, MODULES, ADMIN, "admin", "verwaltung.users", false)).rejects.toThrow(ValidationError);
  });

  it("Gruppen-Grant: SV darf in die Verwaltung, nach Entfernen nicht mehr", async () => {
    const [member] = await h.db.select({ id: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, "g-sv"), eq(groupMembers.role, "member"))).limit(1);
    expect(await can(h.db, member!.id, "verwaltung.access")).toBe(false);
    await addGroupGrant(h.db, MODULES, ADMIN, "g-sv", "verwaltung.access");
    expect(await can(h.db, member!.id, "verwaltung.access")).toBe(true);
    const grants = await listGroupGrants(h.db);
    const svGrant = grants.find((g) => g.groupId === "g-sv");
    expect(svGrant?.permission).toBe("verwaltung.access");
    // Schulleitung hat aus dem Seed "verwaltung.*"
    expect(grants.some((g) => g.groupId === "g-schulleitung" && g.permission === "verwaltung.*")).toBe(true);
    await removeGrant(h.db, ADMIN, svGrant!.id);
    expect((await listGroupGrants(h.db)).some((g) => g.groupId === "g-sv")).toBe(false);
    expect(await can(h.db, member!.id, "verwaltung.access")).toBe(false);
  });

  it("Module an/aus, Kernmodule bleiben an", async () => {
    const fake = { id: "test", name: "Test", description: "", icon: "Box", section: "unterricht" as const };
    await toggleModule(h.db, ADMIN, fake, false);
    expect(isEnabled(fake, await loadModuleStates(h.db))).toBe(false);
    const verwaltung = MODULES.find((m) => m.id === "verwaltung")!;
    await expect(toggleModule(h.db, ADMIN, verwaltung, false)).rejects.toThrow(/Kernmodul/);
  });

  it("Moduleinstellung ändern: nur deklarierte Werte, protokolliert (Q5-14)", async () => {
    const messenger = MODULES.find((m) => m.id === "messenger")!;
    await expect(setModuleSetting(h.db, ADMIN, messenger, "messenger.gibts_nicht", "aus")).rejects.toThrow(ValidationError);
    await expect(setModuleSetting(h.db, ADMIN, messenger, STUDENT_DIRECT.key, "alle")).rejects.toThrow(ValidationError);
    await setModuleSetting(h.db, ADMIN, messenger, STUDENT_DIRECT.key, "aus");
    expect(await readModuleSetting(h.db, STUDENT_DIRECT)).toBe("aus");
    const [last] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.module.setting")).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(last).toMatchObject({ actorId: ADMIN, target: "messenger", meta: { key: STUDENT_DIRECT.key, from: "klasse", to: "aus" } });
  });
});
