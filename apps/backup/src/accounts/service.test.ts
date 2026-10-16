import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "@/auth/auth";
import type { DbHandle } from "@/db/client";
import { auditLog, sessions, twoFactors, users } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { AccountError, changeOwnPassword, createAccount, listAccounts, resetPassword, resetTwoFactor, setLocked } from "./service";

const PW = "Tafel Kreide Pause";

describe("Konten des Backupservers", () => {
  let h: DbHandle;
  let auth: Auth;
  const signIn = (username: string, password: string) => auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
  const cookie = (hd: Headers) => new Headers({ cookie: hd.getSetCookie().map((c) => c.split(";")[0]).join("; ") });

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    await createUserWithPassword(h.db, { id: "a1", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: await hashPassword(PW) });
  });
  afterAll(() => h.close());

  it("neues Konto mit Startpasswort; Pflicht-Wechsel prüft die Regeln und löscht das Flag", async () => {
    const { id, password } = await createAccount(h.db, "a1", { firstName: "Bert", lastName: "Backup", username: "B.Backup" });
    expect(password).toHaveLength(12);
    expect((await listAccounts(h.db)).find((a) => a.id === id)).toMatchObject({ username: "b.backup", mustChangePassword: true, twoFactorEnabled: false });
    await expect(createAccount(h.db, "a1", { firstName: "X", lastName: "Y", username: "b.backup" })).rejects.toThrow("vergeben");
    await expect(createAccount(h.db, "a1", { firstName: "X", lastName: "Y", username: "x y" })).rejects.toThrow(AccountError);

    const { headers } = await signIn("b.backup", password);
    const user = { id, username: "b.backup", firstName: "Bert", lastName: "Backup" };
    expect(await changeOwnPassword(h.db, auth, cookie(headers), user, { current: password, next: "Backup2026!", repeat: "Backup2026!" })).toMatchObject({
      next: expect.any(String),
    });
    expect(await changeOwnPassword(h.db, auth, cookie(headers), user, { current: "falsch", next: PW, repeat: PW })).toEqual({ current: "Das bisherige Passwort ist falsch." });
    expect(await changeOwnPassword(h.db, auth, cookie(headers), user, { current: password, next: PW, repeat: PW })).toBeNull();
    expect((await h.db.select().from(users).where(eq(users.id, id)))[0]!.mustChangePassword).toBe(false);
  });

  it("sperren, 2FA und Passwort zurücksetzen – nie am eigenen Konto, das letzte aktive bleibt", async () => {
    const [b] = await h.db.select().from(users).where(eq(users.username, "b.backup"));
    await expect(setLocked(h.db, "a1", "a1", true)).rejects.toThrow("eigenen Konto");
    await setLocked(h.db, "a1", b!.id, true);
    await expect(signIn("b.backup", PW)).rejects.toThrow();
    await expect(setLocked(h.db, b!.id, "a1", true)).rejects.toThrow("letzte aktive");
    await setLocked(h.db, "a1", b!.id, false);

    await h.db.insert(twoFactors).values({ id: "tf", secret: "s", backupCodes: "c", userId: b!.id });
    await h.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, b!.id));
    await resetTwoFactor(h.db, "a1", b!.id);
    expect((await h.db.select().from(users).where(eq(users.id, b!.id)))[0]!.twoFactorEnabled).toBe(false);
    expect(await h.db.select().from(twoFactors).where(eq(twoFactors.userId, b!.id))).toHaveLength(0);

    await signIn("b.backup", PW);
    const fresh = await resetPassword(h.db, "a1", b!.id);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, b!.id))).toHaveLength(0);
    await expect(signIn("b.backup", PW)).rejects.toThrow();
    await signIn("b.backup", fresh);
    expect((await h.db.select().from(users).where(eq(users.id, b!.id)))[0]!.mustChangePassword).toBe(true);

    const actions = (await h.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["konto.angelegt", "konto.gesperrt", "konto.entsperrt", "konto.2fa_zurueckgesetzt", "konto.passwort_zurueckgesetzt", "konto.passwort_geaendert"]),
    );
  });
});
