import { count, eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { localStorage } from "@/core/files/storage";
import { readSchoolSettings, readSecuritySettings } from "@/core/settings";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import type { DbHandle } from "@/core/db/client";
import { accounts, appSettings, auditLog, authThrottle, sessions, twoFactors, users } from "@/core/db/schema";
import { createUserWithPassword } from "@/core/auth/auth";
import { initializeInstance } from "@/core/instance";
import { demoReset, probeSmoke, resetAdmin } from "./ops";

let h: DbHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const env = {
  SCHULOS_INSTANCE: "production",
  SCHULOS_ADMIN_USERNAME: "chef",
  SCHULOS_ADMIN_FIRST_NAME: "Maria",
  SCHULOS_ADMIN_LAST_NAME: "Müller",
  SCHULOS_ADMIN_PASSWORD: "Kastanienbaum-Fahrrad-7",
};

describe("schulosctl reset-admin", () => {
  it("neues Passwort, 2FA aus, Sperre und Sitzungen weg, Protokoll", async () => {
    h = await createTestDb();
    const { db } = h;
    await initializeInstance(db, env);
    const id = "u-chef";
    await db.update(users).set({ twoFactorEnabled: true, status: "locked" }).where(eq(users.id, id));
    await db.insert(twoFactors).values({ id: "tf1", secret: "x", backupCodes: "y", userId: id });
    await db.insert(authThrottle).values({ key: "u:chef", failures: 9, windowStartedAt: new Date(), lockedUntil: new Date(Date.now() + 3600_000) });
    await db.insert(sessions).values({ id: "s1", token: "t1", userId: id, expiresAt: new Date(Date.now() + 3600_000) });
    // G4E-C02: ausgesperrt durch falsche Schulnetz-Bereiche – reset-admin setzt sie auf die Vorgabe zurück
    await db.insert(appSettings).values({ key: "sicherheit.schulnetz", value: "10.20.0.0/16" });

    const r = await resetAdmin(db);
    expect(r.schoolNetsReset).toBe(true);
    expect((await readSecuritySettings(db)).schoolNets).toBeNull();
    expect(r.username).toBe("chef");
    expect(r.password.length).toBeGreaterThanOrEqual(10);
    const [acc] = await db.select().from(accounts).where(eq(accounts.userId, id));
    expect(await verifyPassword({ hash: acc!.password!, password: r.password })).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ twoFactorEnabled: false, status: "active", mustChangePassword: true });
    expect(await db.select().from(twoFactors)).toHaveLength(0);
    expect(await db.select().from(authThrottle)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
    const log = await db.select().from(auditLog).where(eq(auditLog.action, "system.admin_zurueckgesetzt"));
    expect(log).toMatchObject([{ actorId: null, target: id }]);
  });

  it("mehrere Admins → Name nötig; unbekannter Name und Nicht-Admin werden abgelehnt", async () => {
    h = await createTestDb();
    const { db } = h;
    await initializeInstance(db, env);
    await createUserWithPassword(db, { id: "u-zwei", name: "Zweite Admin", username: "zwei", role: "admin" }, { plain: "irgendwas-langes-1" });
    await createUserWithPassword(db, { id: "u-lk", name: "Lehrkraft", username: "lk", role: "lehrkraft" }, { plain: "irgendwas-langes-1" });
    await expect(resetAdmin(db)).rejects.toThrow("Mehrere Admin-Konten (");
    await expect(resetAdmin(db, "lk")).rejects.toThrow("Kein Admin-Konto „lk“");
    expect((await resetAdmin(db, " Zwei ")).username).toBe("zwei");
  });

  it("ohne Admin-Konto", async () => {
    h = await createTestDb();
    await expect(resetAdmin(h.db)).rejects.toThrow("Es gibt kein Admin-Konto");
  });
});

describe("schulosctl demo-reset", () => {
  it("Produktivinstanz wird verweigert", async () => {
    h = await createTestDb();
    await initializeInstance(h.db, env);
    await expect(demoReset(h.db, {})).rejects.toThrow("keine Demo-Instanz");
    const empty = await createTestDb();
    try {
      await expect(demoReset(empty.db, {})).rejects.toThrow("keine Demo-Instanz"); // leer
    } finally {
      await empty.close();
    }
    // zwei frische Datenbanken + Admin-Hash: unter Volllast (ganze Suite parallel) dauert das über 30 s
  }, 120_000);

  it("Demo: Änderungen weg, Demo-Schule frisch", async () => {
    h = await createSeededTestDb();
    const { db } = h;
    const before = (await db.select({ n: count() }).from(users))[0]!.n;
    await createUserWithPassword(db, { id: "u-neu", name: "Neu", username: "neu", role: "lehrkraft" }, { plain: "irgendwas-langes-1" });
    await db.update(users).set({ firstName: "Geändert" }).where(eq(users.username, "jana.brandt"));

    const r = await demoReset(db, {});
    expect(r.users).toBe(before);
    expect(await db.select().from(users).where(eq(users.username, "neu"))).toHaveLength(0);
    const [jana] = await db.select().from(users).where(eq(users.username, "jana.brandt"));
    expect(jana!.firstName).toBe("Jana");
    // danach weiterhin als Demo erkannt; mit Dateispeicher: Uploads weg, Demo-Logo (P4-05) und Beispieltafel (P3-12) neu
    const dir = await mkdtemp(join(os.tmpdir(), "schulos-demoreset-"));
    try {
      const storage = localStorage(dir);
      const upload = crypto.randomUUID();
      await storage.put(upload, new Uint8Array([1]));
      expect((await demoReset(db, {}, storage)).users).toBe(before);
      const keys = (await storage.list()).map((f) => f.key);
      expect(keys).not.toContain(upload);
      expect(keys).toHaveLength(4); // drei Logo-Varianten + Beispieltafel
      expect(Object.keys((await readSchoolSettings(db)).logos)).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("Rauchtest im Probelauf", () => {
  function fakeFetch(opts: { signIn?: number; pages?: Record<string, number> } = {}) {
    const seen: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const path = url.replace("http://127.0.0.1:3000", "");
      seen.push(`${init?.method ?? "GET"} ${path}${(init?.headers as Record<string, string> | undefined)?.cookie ? " +cookie" : ""}`);
      if (path === "/api/health") return new Response("{}", { status: 200 });
      if (path === "/api/auth/sign-in/username") {
        const body = JSON.parse(String(init?.body)) as { username: string };
        expect(body.username).toMatch(/^probelauf\.[0-9a-f]{8}$/);
        return new Response("{}", { status: opts.signIn ?? 200, headers: { "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly" } });
      }
      return new Response("<html>", { status: opts.pages?.[path] ?? 200 });
    }) as unknown as typeof fetch;
    return { impl, seen };
  }

  it("meldet sich mit einem technischen Konto an, ruft Seiten ab, löscht das Konto wieder", async () => {
    h = await createSeededTestDb();
    const before = (await h.db.select({ n: count() }).from(users))[0]!.n;
    const f = fakeFetch();
    const r = await probeSmoke(h.db, "http://127.0.0.1:3000", f.impl);
    expect(r).toMatchObject({ ok: true, details: { konten: before, seiten: { "/": 200, "/stundenplan": 200 } } });
    expect(r.details.tabellen).toBeGreaterThan(40);
    expect(f.seen).toEqual(["GET /api/health", "POST /api/auth/sign-in/username", "GET / +cookie", "GET /stundenplan +cookie"]);
    expect((await h.db.select({ n: count() }).from(users))[0]!.n).toBe(before);
  });

  it("Fehler werden gemeldet, Konto trotzdem weg", async () => {
    h = await createTestDb();
    const r1 = await probeSmoke(h.db, "http://127.0.0.1:3000", fakeFetch({ signIn: 401 }).impl);
    expect(r1).toMatchObject({ ok: false, error: "Anmeldung 401" });
    const r2 = await probeSmoke(h.db, "http://127.0.0.1:3000", fakeFetch({ pages: { "/stundenplan": 500 } }).impl);
    expect(r2).toMatchObject({ ok: false, error: "Seite /stundenplan: 500" });
    expect(await h.db.select().from(users)).toHaveLength(0);
  });
});
