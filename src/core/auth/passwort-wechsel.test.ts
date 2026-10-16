import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, sessions, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { hasPermission, loadPermissions } from "@/core/permissions";
import { createUser, resetPassword } from "@/modules/verwaltung/users";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";
import { changeOwnPassword } from "./passwort-wechsel";

describe("Pflicht-Wechsel des Startpassworts", () => {
  let h: DbHandle;
  let auth: Auth;

  async function sessionHeaders(username: string, password: string) {
    const { headers } = await auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return new Headers({ cookie });
  }

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    await createUserWithPassword(h.db, { id: "adm", name: "Admin", username: "admin", role: "admin" }, { hash: await hashPassword("admin-geheim-1") });
  });
  afterAll(() => h.close());

  it("neue Konten und zurückgesetzte Passwörter müssen gewechselt werden – bis dahin keine Rechte", async () => {
    const created = await createUser(h.db, "adm", { firstName: "Nina", lastName: "Neu", role: "lehrkraft", shortCode: null, username: null });
    const perms = await loadPermissions(h.db, created.id);
    expect(perms.passwordChangePending).toBe(true);
    expect(hasPermission({ ...perms, role: "admin" }, "irgendwas")).toBe(false);

    const hdrs = await sessionHeaders(created.username, created.password);
    const me = { id: created.id, username: created.username, firstName: "Nina", lastName: "Neu" };
    const input = (next: string, repeat = next, current = created.password) => ({ current, next, repeat });

    expect(await changeOwnPassword(h.db, auth, hdrs, me, input("kurz"))).toEqual({ next: "Mindestens 10 Zeichen." });
    expect(await changeOwnPassword(h.db, auth, hdrs, me, input("Nina mag Mathe"))).toEqual({ next: expect.stringMatching(/Namen/) });
    expect(await changeOwnPassword(h.db, auth, hdrs, me, input("Tafel Kreide Pause", "anders"))).toEqual({ repeat: expect.any(String) });
    expect(await changeOwnPassword(h.db, auth, hdrs, me, input("Tafel Kreide Pause", "Tafel Kreide Pause", "falsch!!!!"))).toEqual({
      current: "Das bisherige Passwort ist falsch.",
    });
    expect(await changeOwnPassword(h.db, auth, hdrs, me, input("Tafel Kreide Pause"))).toBeNull();
    expect((await loadPermissions(h.db, created.id)).passwordChangePending).toBe(false);
    expect((await auth.api.signInUsername({ body: { username: created.username, password: "Tafel Kreide Pause" } })).token).toBeTruthy();
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.passwort.geaendert"));
    expect(row?.target).toBe(created.id);

    // Reset durch die Verwaltung: wieder Pflicht, alle Sitzungen weg
    const pw = await resetPassword(h.db, "adm", created.id);
    expect((await loadPermissions(h.db, created.id)).passwordChangePending).toBe(true);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, created.id))).toHaveLength(0);
    expect((await auth.api.signInUsername({ body: { username: created.username, password: pw } })).token).toBeTruthy();
  });

  it("Demo-Konten und bestehende Konten haben kein Pflicht-Flag; Anmeldung mit kurzem Altpasswort geht weiter", async () => {
    await createUserWithPassword(h.db, { id: "alt", name: "Alt Konto", username: "alt", role: "lehrkraft" }, { hash: await hashPassword("schulos") });
    const [u] = await h.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, "alt"));
    expect(u?.m).toBe(false);
    expect((await auth.api.signInUsername({ body: { username: "alt", password: "schulos" } })).token).toBeTruthy();
  });
});
