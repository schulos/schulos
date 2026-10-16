import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetTwoFactor } from "@/core/auth/zwei-faktor";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, ROLES, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { onEndLiveStreams } from "@/core/notifications/bus";
import { requestErasure, setAccountLeft } from "@/core/privacy/konto";
import { MODULES } from "@/modules";
import { actorHas, assignableRoles, loadActor, manageProblem } from "./escalation";
import { addMembers } from "./groups";
import { addGroupGrant, setRoleGrant } from "./rights";
import { createUser, resetPassword, setUserLocked, updateUser, ValidationError } from "./users";

const ADMIN = "u-admin";
const SEKRETARIAT = "u-sabine.kowalski"; // Rolle verwaltung: verwaltung.users + verwaltung.groups
const SCHULLEITUNG = "u-petra.lindner"; // Lehrkraft in der Gruppe Schulleitung (verwaltung.* u. a.)
const LEHRKRAFT = "u-jana.brandt";

/** Erwartet eine ValidationError mit einer Meldung, die zum Muster passt. */
async function refused(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect(Object.values((err as ValidationError).fieldErrors).join(" ")).toMatch(pattern);
}

describe("Rechteausweitung in der Verwaltung (SEC-04)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  const role = async (id: string) => (await h.db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]?.role;

  it("Sekretariat kann keine Admin-Konten anlegen und keine Rolle auf Admin setzen – auch nicht die eigene", async () => {
    await refused(createUser(h.db, SEKRETARIAT, { firstName: "Max", lastName: "Macht", role: "admin" }), /nur ein Admin/);
    await refused(updateUser(h.db, SEKRETARIAT, SEKRETARIAT, { firstName: "Sabine", lastName: "Kowalski", role: "admin" }), /eigene Rolle/);
    await refused(updateUser(h.db, SEKRETARIAT, LEHRKRAFT, { firstName: "Jana", lastName: "Brandt", role: "admin" }), /nur ein Admin/);
    expect(await role(SEKRETARIAT)).toBe("verwaltung");
    expect(await role(LEHRKRAFT)).toBe("lehrkraft");
    // normale Konten anlegen geht weiter
    const created = await createUser(h.db, SEKRETARIAT, { firstName: "Nora", lastName: "Neu", role: "lehrkraft", shortCode: "QXZ" });
    expect(await role(created.id)).toBe("lehrkraft");
  });

  it("Admin-Konten verwaltet nur ein Admin: kein Passwort-/2FA-Reset, keine Sperre, kein Abgang, keine Löschung", async () => {
    await refused(resetPassword(h.db, SEKRETARIAT, ADMIN), /Admin-Konten/);
    await refused(resetTwoFactor(h.db, SEKRETARIAT, ADMIN), /Admin-Konten/);
    await refused(setUserLocked(h.db, SEKRETARIAT, ADMIN, true), /Admin-Konten/);
    await refused(setAccountLeft(h.db, SEKRETARIAT, ADMIN, "2026-10-10"), /Admin-Konten/);
    await refused(requestErasure(h.db, SCHULLEITUNG, ADMIN, "2026-10-10"), /Admin-Konten/);
    await refused(updateUser(h.db, SCHULLEITUNG, ADMIN, { firstName: "Admin", lastName: "IT", role: "lehrkraft" }), /Admin-Konten/);
    expect(await role(ADMIN)).toBe("admin");
    const [admin] = await h.db.select({ status: users.status }).from(users).where(eq(users.id, ADMIN));
    expect(admin?.status).toBe("active");
  });

  it("Konten mit mehr Verwaltungsrechten (Schulleitung) kann das Sekretariat nicht übernehmen", async () => {
    await refused(resetPassword(h.db, SEKRETARIAT, SCHULLEITUNG), /Verwaltungsrechte, die du selbst nicht hast/);
    await refused(resetTwoFactor(h.db, SEKRETARIAT, SCHULLEITUNG), /Verwaltungsrechte/);
    expect(await manageProblem(h.db, await loadActor(h.db, SEKRETARIAT), LEHRKRAFT)).toBeNull();
    // Schulleitung (verwaltung.*) darf das Sekretariat verwalten, Admin alles
    expect(await resetPassword(h.db, SCHULLEITUNG, SEKRETARIAT)).toBeTruthy();
    expect(await resetPassword(h.db, ADMIN, SCHULLEITUNG)).toBeTruthy();
  });

  it("Auswahl der Rollen: Admin nur für Admins", async () => {
    expect(await assignableRoles(h.db, await loadActor(h.db, SEKRETARIAT), ROLES)).not.toContain("admin");
    expect(await assignableRoles(h.db, await loadActor(h.db, SEKRETARIAT), ROLES)).toContain("lehrkraft");
    expect(await assignableRoles(h.db, await loadActor(h.db, ADMIN), ROLES)).toContain("admin");
    // unbekannte handelnde Person darf nichts Verwaltendes (fail closed)
    const nobody = await loadActor(h.db, "gibts-nicht");
    expect(actorHas(nobody, "verwaltung.users")).toBe(false);
    expect(await assignableRoles(h.db, nobody, ROLES)).not.toContain("verwaltung");
  });

  it("Gruppen mit eigenen Rechten: nicht sich selbst aufnehmen, keine Rechte weitergeben, die man nicht hat", async () => {
    await refused(addMembers(h.db, SEKRETARIAT, "g-schulleitung", [SEKRETARIAT]), /nur jemand anderes/);
    await refused(addMembers(h.db, SEKRETARIAT, "g-schulleitung", [LEHRKRAFT]), /Rechte, die du selbst nicht hast/);
    const members = await h.db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, "g-schulleitung"));
    expect(members.map((m) => m.id)).not.toContain(SEKRETARIAT);
    // Gruppen ohne eigene Rechte wie bisher; die Schulleitung hat selbst alle Rechte ihrer Gruppe
    expect(await addMembers(h.db, SEKRETARIAT, "g-7b", [SEKRETARIAT])).toBe(1);
    expect(await addMembers(h.db, SCHULLEITUNG, "g-schulleitung", [LEHRKRAFT])).toBe(1);
  });

  it("Rolle Personal (P4-10): Sekretariat legt Hausmeister an und nimmt sie in die Hausmeisterei auf; dort niemand sich selbst", async () => {
    expect(await assignableRoles(h.db, await loadActor(h.db, SEKRETARIAT), ROLES)).toContain("personal");
    const created = await createUser(h.db, SEKRETARIAT, { firstName: "Hanna", lastName: "Hammer", role: "personal" });
    expect(await role(created.id)).toBe("personal");
    // Gruppe mit eigenem Recht gebaeude.manage: das Sekretariat hat es selbst (Vorgabe der Rolle verwaltung)
    expect(await addMembers(h.db, SEKRETARIAT, "g-hausmeisterei", [created.id])).toBe(1);
    await refused(addMembers(h.db, created.id, "g-hausmeisterei", [created.id]), /nur jemand anderes/);
    // eine Lehrkraft ohne gebaeude.manage gibt das Recht nicht weiter
    await refused(addMembers(h.db, LEHRKRAFT, "g-hausmeisterei", [LEHRKRAFT, created.id]), /nur jemand anderes|Rechte, die du selbst nicht hast/);
    // die Rolle Personal bekommt Verwaltungsrechte nur von jemandem, der sie selbst hat
    await refused(setRoleGrant(h.db, MODULES, SEKRETARIAT, "personal", "verwaltung.system", true), /selbst nicht/);
    // Personal darf das Sekretariat nicht verwalten
    expect(await manageProblem(h.db, await loadActor(h.db, created.id), SEKRETARIAT)).toMatch(/Verwaltungsrechte/);
  });

  it("Rechteverwaltung: nur eigene Rechte vergeben, nicht an die eigene Rolle oder eigene Gruppen", async () => {
    await refused(setRoleGrant(h.db, MODULES, SCHULLEITUNG, "lehrkraft", "verwaltung.users", true), /eigenen Rolle/);
    await refused(addGroupGrant(h.db, MODULES, SCHULLEITUNG, "g-schulleitung", "verwaltung.access"), /in der du selbst bist/);
    await refused(setRoleGrant(h.db, MODULES, SEKRETARIAT, "eltern", "verwaltung.system", true), /selbst nicht/);
    await setRoleGrant(h.db, MODULES, SCHULLEITUNG, "eltern", "verwaltung.access", true);
    await setRoleGrant(h.db, MODULES, SCHULLEITUNG, "eltern", "verwaltung.access", false);
    // Entziehen ist keine Ausweitung
    await setRoleGrant(h.db, MODULES, SCHULLEITUNG, "lehrkraft", "verwaltung.access", false);
  });

  it("Sperre und Passwort-Reset beenden offene Live-Ströme sofort", async () => {
    const ended: string[] = [];
    const off = onEndLiveStreams("u-lea.schaefer", () => ended.push("x"));
    await setUserLocked(h.db, SEKRETARIAT, "u-lea.schaefer", true);
    await setUserLocked(h.db, SEKRETARIAT, "u-lea.schaefer", false);
    await resetPassword(h.db, SEKRETARIAT, "u-lea.schaefer");
    off();
    expect(ended).toHaveLength(2);
  });
});
