import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { appSettings, auditLog, grants, mailOutbox, sessions, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { hasPermission, loadPermissions, twoFactorDuty } from "@/core/permissions";
import { readSecuritySettings, SECURITY_KEYS } from "@/core/settings";
import { normalizeNetText, resetSchoolNets, saveSecuritySettings, SecuritySettingsError } from "./anmelde-einstellungen";
import { createUserWithPassword } from "./auth";
import { factorAddAllowedFor, outsideBlock, requestNetwork, setupAllowed, setupAllowedFor, withNetworkRules } from "./pflicht";
import { notifyTwoFactorEnabled, releaseExternalSetup, twoFactorStatus } from "./zwei-faktor";

const OUTSIDE = new Headers({ "x-forwarded-for": "203.0.113.7" });
const INSIDE = new Headers({ "x-forwarded-for": "10.1.2.3" });

describe("SEC-01: Pflicht je Rolle (rein)", () => {
  const from = "2026-11-11";
  it("Verwaltungsrechte, Admin, Beratung sofort; Lehrkraft, Personal, Eltern ab Stichtag; Schüler:innen nur von außen", () => {
    for (const role of ["admin", "verwaltung", "beratung"] as const)
      expect(twoFactorDuty(role, [], from, "2026-10-14")).toEqual({
        required: true,
        dueOn: null,
        outsideOnly: false,
      });
    expect(twoFactorDuty("lehrkraft", ["verwaltung.users"], from, "2026-10-14").required).toBe(true);
    for (const role of ["lehrkraft", "personal", "eltern"] as const) {
      expect(twoFactorDuty(role, [], from, "2026-11-10")).toEqual({
        required: false,
        dueOn: from,
        outsideOnly: false,
      });
      expect(twoFactorDuty(role, [], from, "2026-11-11")).toEqual({
        required: true,
        dueOn: null,
        outsideOnly: false,
      });
      expect(twoFactorDuty(role, [], null, "2030-01-01")).toEqual({
        required: false,
        dueOn: null,
        outsideOnly: false,
      });
    }
    expect(twoFactorDuty("schueler", [], from, "2027-01-01")).toEqual({
      required: false,
      dueOn: null,
      outsideOnly: true,
    });
  });

  it("von außen: mit 2FA nur mit gekennzeichneter Sitzung, ohne 2FA nur in Demo-Instanzen", () => {
    expect(
      outsideBlock({
        outside: false,
        has2FA: false,
        sessionMarked: false,
        demo: false,
      }),
    ).toBeNull();
    expect(
      outsideBlock({
        outside: true,
        has2FA: false,
        sessionMarked: false,
        demo: false,
      }),
    ).toBe("aussen-ohne");
    expect(
      outsideBlock({
        outside: true,
        has2FA: false,
        sessionMarked: false,
        demo: true,
      }),
    ).toBeNull();
    expect(
      outsideBlock({
        outside: true,
        has2FA: true,
        sessionMarked: false,
        demo: true,
      }),
    ).toBe("aussen-code");
    expect(
      outsideBlock({
        outside: true,
        has2FA: true,
        sessionMarked: true,
        demo: false,
      }),
    ).toBeNull();
  });

  it("Q-5A-30: Ersteinrichtung im Schulnetz, von außen nur mit Freigabe – Eltern und Demo ausgenommen", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const base = {
      role: "lehrkraft" as const,
      demo: false,
      releasedUntil: null,
      now,
    };
    expect(setupAllowed({ ...base, network: "schulnetz" })).toBe(true);
    expect(setupAllowed({ ...base, network: "aussen" })).toBe(false);
    expect(
      setupAllowed({
        ...base,
        network: "aussen",
        releasedUntil: new Date("2026-10-14T11:00:00Z"),
      }),
    ).toBe(true);
    expect(
      setupAllowed({
        ...base,
        network: "aussen",
        releasedUntil: new Date("2026-10-14T09:00:00Z"),
      }),
    ).toBe(false);
    expect(setupAllowed({ ...base, network: "aussen", role: "eltern" })).toBe(true);
    expect(setupAllowed({ ...base, network: "aussen", role: "schueler" })).toBe(false);
    expect(setupAllowed({ ...base, network: "aussen", demo: true })).toBe(true);
  });
});

describe("SEC-01: Pflicht mit Datenbank", () => {
  let h: DbHandle;
  const hash = { hash: "x" };

  async function setFrom(value: string) {
    await h.db.update(appSettings).set({ value }).where(eq(appSettings.key, SECURITY_KEYS.twoFactorFrom));
  }
  async function session(id: string, userId: string, marked = false) {
    await h.db.insert(sessions).values({
      id,
      token: `t-${id}`,
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      secondFactorAt: marked ? new Date() : null,
    });
  }

  beforeAll(async () => {
    h = await createTestDb();
    for (const [id, role] of [
      ["lk", "lehrkraft"],
      ["pe", "personal"],
      ["el", "eltern"],
      ["sc", "schueler"],
      ["s2", "schueler"],
      ["vw", "verwaltung"],
    ] as const)
      await createUserWithPassword(h.db, { id, name: `Konto ${id}`, username: id, role }, hash);
    await h.db.insert(grants).values({ permission: "news.read", role: "lehrkraft" });
  });
  afterAll(() => h.close());

  it("Migration 0078 setzt den Stichtag auf vier Wochen nach dem Update", async () => {
    const { twoFactorFrom } = await readSecuritySettings(h.db);
    const expected = new Date(Date.now() + 28 * 86_400_000).toISOString().slice(0, 10);
    expect(twoFactorFrom).toBe(expected);
  });

  it("vor dem Stichtag Hinweis statt Sperre, danach gesperrt; Schüler:innen nie ohne Anfrage", async () => {
    const before = await loadPermissions(h.db, "lk", new Date("2026-10-14T10:00:00Z"));
    await setFrom("2026-11-11");
    const due = await loadPermissions(h.db, "lk", new Date("2026-10-14T10:00:00Z"));
    expect(due.twoFactorPending).toBe(false);
    expect(due.twoFactorDueOn).toBe("2026-11-11");
    expect(hasPermission(due, "news.read")).toBe(true);
    for (const id of ["lk", "pe", "el"]) {
      const p = await loadPermissions(h.db, id, new Date("2026-11-11T08:00:00Z"));
      expect(p.twoFactorPending).toBe(true);
      expect(p.twoFactorDueOn).toBeUndefined();
    }
    expect(hasPermission(await loadPermissions(h.db, "lk", new Date("2026-11-11T08:00:00Z")), "news.read")).toBe(false);
    expect((await loadPermissions(h.db, "sc", new Date("2027-01-01T08:00:00Z"))).twoFactorPending).toBe(false);
    expect((await loadPermissions(h.db, "vw", new Date("2026-10-14T08:00:00Z"))).twoFactorPending).toBe(true);
    expect(before.userId).toBe("lk");
    // Demo: keine Pflicht, kein Hinweis
    await h.db.insert(appSettings).values({ key: "demo", value: true });
    const demo = await loadPermissions(h.db, "lk", new Date("2026-11-12T08:00:00Z"));
    expect(demo.twoFactorPending).toBe(false);
    expect(demo.twoFactorDueOn).toBeUndefined();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    // Status für die 2FA-Seite
    const status = await twoFactorStatus(h.db, due, new Date("2026-10-14T10:00:00Z"));
    expect(status).toMatchObject({
      enabled: false,
      required: false,
      enforced: false,
      dueOn: "2026-11-11",
    });
  });

  it("Schülerin: im Schulnetz frei, von außen ohne 2FA gesperrt, mit 2FA nur mit Code-Sitzung", async () => {
    await session("sess-sc", "sc");
    const perms = await loadPermissions(h.db, "sc");
    expect((await withNetworkRules(h.db, INSIDE, "sess-sc", perms)).twoFactorPending).toBeFalsy();
    expect(await withNetworkRules(h.db, new Headers(), "sess-sc", perms)).toBe(perms);
    const outside = await withNetworkRules(h.db, OUTSIDE, "sess-sc", perms);
    expect(outside).toMatchObject({
      twoFactorPending: true,
      twoFactorReason: "aussen-ohne",
    });
    expect(hasPermission(outside, "news.read")).toBe(false);
    // gefälschtes X-Forwarded-For vorne dran hilft nicht
    expect((await withNetworkRules(h.db, new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }), "sess-sc", perms)).twoFactorPending).toBe(true);
    // Kennzeichen von Caddy gilt immer als außen
    expect((await withNetworkRules(h.db, new Headers({ "x-schulos-extern": "alles" }), "sess-sc", perms)).twoFactorPending).toBe(true);

    await h.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, "s2"));
    await session("sess-s2", "s2");
    await session("sess-s2-code", "s2", true);
    const p2 = await loadPermissions(h.db, "s2");
    expect(await withNetworkRules(h.db, OUTSIDE, "sess-s2", p2)).toMatchObject({
      twoFactorReason: "aussen-code",
    });
    expect((await withNetworkRules(h.db, OUTSIDE, "sess-s2-code", p2)).twoFactorPending).toBeFalsy();
    // fremde Sitzung zählt nicht
    expect((await withNetworkRules(h.db, OUTSIDE, "sess-s2-code", perms)).twoFactorPending).toBe(true);
    // Lehrkräfte hängen nicht vom Ort ab
    const lk = await loadPermissions(h.db, "lk", new Date("2026-10-14T10:00:00Z"));
    expect(await withNetworkRules(h.db, OUTSIDE, "x", lk)).toBe(lk);
  });

  it("Schulnetz und Stichtag nur im Schulnetz änderbar; eigene Bereiche wirken auf die Zone", async () => {
    expect(await requestNetwork(h.db, new Headers({ "x-forwarded-for": "100.64.1.1" }))).toBe("aussen");
    await expect(
      saveSecuritySettings(h.db, "vw", "aussen", {
        schoolNets: "",
        twoFactorFrom: "2026-12-01", idleMinutes: 0,
      }),
    ).rejects.toBeInstanceOf(SecuritySettingsError);
    await expect(
      saveSecuritySettings(h.db, "vw", "schulnetz", {
        schoolNets: "100.64.0.0/10 quatsch",
        twoFactorFrom: "2026-12-01", idleMinutes: 0,
      }),
    ).rejects.toThrow("quatsch");
    await expect(
      saveSecuritySettings(h.db, "vw", "schulnetz", {
        schoolNets: "",
        twoFactorFrom: "2026-02-30", idleMinutes: 0,
      }),
    ).rejects.toThrow("Stichtag");
    await saveSecuritySettings(h.db, "vw", "schulnetz", {
      schoolNets: "100.64.0.0/10,\n10.0.0.0/8",
      twoFactorFrom: "2026-12-01", idleMinutes: 0,
    });
    expect(await readSecuritySettings(h.db)).toMatchObject({
      schoolNets: "100.64.0.0/10 10.0.0.0/8",
      twoFactorFrom: "2026-12-01", idleMinutes: 0,
    });
    expect(await requestNetwork(h.db, new Headers({ "x-forwarded-for": "100.64.1.1" }))).toBe("schulnetz");
    expect(await requestNetwork(h.db, new Headers({ "x-forwarded-for": "192.168.1.1" }))).toBe("aussen");
    // G4E-O06: Host-Bits werden auf die Netzadresse normiert gespeichert (gemeint ist das Netz), private_ranges bleibt
    expect(normalizeNetText("10.10.0.5/24, private_ranges FD00:0:0:0:0:0:0:1/8")).toBe("10.10.0.0/24 private_ranges fd00::/8");
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.anmeldung.einstellungen"));
    expect(row?.actorId).toBe("vw");
    await saveSecuritySettings(h.db, "vw", "schulnetz", {
      schoolNets: "",
      twoFactorFrom: "2026-12-01", idleMinutes: 0,
    });
    expect((await readSecuritySettings(h.db)).schoolNets).toBeNull();
  });

  it("G4E-C10: wer schon einen zweiten Faktor hat, ergänzt Code-App oder Schlüssel auch von außen; sonst gilt die Ersteinrichtung", async () => {
    await h.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, "s2"));
    expect(await setupAllowedFor(h.db, OUTSIDE, "s2")).toBe(false);
    expect(await factorAddAllowedFor(h.db, OUTSIDE, "s2")).toBe(true);
    expect(await factorAddAllowedFor(h.db, OUTSIDE, "sc")).toBe(false);
    expect(await factorAddAllowedFor(h.db, INSIDE, "sc")).toBe(true);
  });

  it("G4E-C02: Speichern nur, wenn die eigene Adresse in den NEUEN Bereichen liegt (oder ausdrücklich bestätigt); Rettungsweg", async () => {
    const input = { schoolNets: "10.20.0.0/16", twoFactorFrom: "2026-12-01", idleMinutes: 0 };
    // Tippfehler: das Verwaltungsnetz ist 10.30.0.0/16 – abgelehnt, nichts gespeichert
    const err = await saveSecuritySettings(h.db, "vw", "schulnetz", input, { clientIp: "10.30.1.5" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecuritySettingsError);
    expect((err as SecuritySettingsError).ownAddressOutside).toBe("10.30.1.5");
    expect((err as Error).message).toMatch(/10\.30\.1\.5 liegt nicht in den neuen Bereichen/);
    expect((await readSecuritySettings(h.db)).schoolNets).toBeNull();
    // leer = Vorgabe (alle privaten Bereiche): eine öffentliche eigene Adresse fällt ebenso heraus
    await expect(saveSecuritySettings(h.db, "vw", "schulnetz", { ...input, schoolNets: "" }, { clientIp: "203.0.113.9" }, {})).rejects.toThrow(/203\.0\.113\.9/);
    await saveSecuritySettings(h.db, "vw", "schulnetz", { ...input, schoolNets: "" }, { clientIp: "10.30.1.5" }, {});
    // eigene Adresse drin: geht
    await saveSecuritySettings(h.db, "vw", "schulnetz", { ...input, schoolNets: "10.30.0.0/16" }, { clientIp: "10.30.1.5" });
    expect((await readSecuritySettings(h.db)).schoolNets).toBe("10.30.0.0/16");
    // ausdrücklich bestätigt: geht, Protokoll vermerkt es
    await saveSecuritySettings(h.db, "vw", "schulnetz", input, { clientIp: "10.30.1.5", confirmOwnAddressOutside: true });
    expect((await readSecuritySettings(h.db)).schoolNets).toBe("10.20.0.0/16");
    const logs = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.anmeldung.einstellungen"));
    expect(logs.at(-1)?.meta).toMatchObject({ eigeneAdresseAussen: true });
    // Rettungsweg (Kommandozeile): zurück auf die Vorgabe
    expect(await resetSchoolNets(h.db)).toBe(true);
    expect((await readSecuritySettings(h.db)).schoolNets).toBeNull();
    expect(await resetSchoolNets(h.db)).toBe(false);
  });

  it("Q-5A-30: Freigabe der Verwaltung für 48 h; Hinweis-Mail nur an bestätigte Adressen", async () => {
    const now = new Date();
    expect(await setupAllowedFor(h.db, OUTSIDE, "lk", now)).toBe(false);
    expect(await setupAllowedFor(h.db, INSIDE, "lk", now)).toBe(true);
    expect(await setupAllowedFor(h.db, OUTSIDE, "el", now)).toBe(true);
    const until = await releaseExternalSetup(h.db, "vw", "lk", now);
    expect(until.getTime() - now.getTime()).toBe(48 * 3_600_000);
    expect(await setupAllowedFor(h.db, OUTSIDE, "lk", now)).toBe(true);
    expect(await setupAllowedFor(h.db, OUTSIDE, "lk", new Date(now.getTime() + 49 * 3_600_000))).toBe(false);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.2fa_freigabe"));
    expect(a?.target).toBe("lk");
    await expect(releaseExternalSetup(h.db, "vw", "s2", now)).rejects.toThrow("schon eingerichtet");

    expect(await notifyTwoFactorEnabled(h.db, "lk")).toBe(false); // nur Platzhalter-Adresse
    await h.db.update(users).set({ email: "jana@example.org", emailVerified: false }).where(eq(users.id, "lk"));
    expect(await notifyTwoFactorEnabled(h.db, "lk")).toBe(false); // unbestätigt
    await h.db.update(users).set({ emailVerified: true }).where(eq(users.id, "lk"));
    expect(await notifyTwoFactorEnabled(h.db, "lk")).toBe(true);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, "jana@example.org"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("Zwei-Faktor-Anmeldung wurde eingerichtet");
  });
});
