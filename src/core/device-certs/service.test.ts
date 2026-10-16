import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecureContext } from "node:tls";
import { X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth, createUserWithPassword, hashPassword } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { auditLog, deviceCerts, sessions } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { DEVICE_CERT_HEADER, EXTERN_HEADER } from "@/core/external-access";
import { checkDeviceCa } from "./check";
import { fingerprintOf, issueDeviceCert } from "./issue";
import {
  certCheck,
  DeviceCertError,
  externalAccessFor,
  listDeviceCerts,
  readExternalPolicy,
  readExternalSettings,
  registerDeviceCert,
  revokeDeviceCert,
  saveExternalSettings,
} from "./service";
import { StepCaError, type StepCaConfig } from "./step-ca";
import { fakeStepCa, makeCert, type FakeStepCa } from "./testing";

// P4-40b / SICHERHEIT.md S27/S28: Freigabe-/Sperrliste, Prüfung je Anfrage, Einstellungen, Ausstellung über (nachgebaute) step-ca

const DAY = 86_400_000;
const fp = (c: string) => c.repeat(64);
const now = new Date("2026-10-10T12:00:00Z");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  const hash = await hashPassword("geheim123");
  for (const [id, role] of [
    ["lk", "lehrkraft"],
    ["lk2", "lehrkraft"],
    ["pe", "personal"],
    ["vw", "verwaltung"],
    ["ad", "admin"],
    ["el", "eltern"],
    ["sc", "schueler"],
  ] as const)
    await createUserWithPassword(h.db, { id, name: `Konto ${id}`, username: `konto.${id}`, role }, { hash });
});
afterAll(() => h.close());
afterEach(() => vi.unstubAllEnvs());

const cert = (over: Partial<Parameters<typeof registerDeviceCert>[2]> = {}) => ({
  label: "iPad Lehrerzimmer",
  commonName: "geraet-000000000001",
  fingerprint: fp("a"),
  serial: "01",
  notBefore: new Date(now.getTime() - DAY),
  notAfter: new Date(now.getTime() + 300 * DAY),
  userId: null,
  ...over,
});

const hdr = (o: Record<string, string>) => new Headers(o);

describe("certCheck – nur freigegebene, nicht gesperrte Zertifikate in ihrer Laufzeit", () => {
  beforeAll(async () => {
    await registerDeviceCert(h.db, "ad", cert());
    await registerDeviceCert(h.db, "ad", cert({ commonName: "geraet-b", fingerprint: fp("b"), notAfter: new Date(now.getTime() - 1) }));
    await registerDeviceCert(h.db, "ad", cert({ commonName: "geraet-c", fingerprint: fp("c"), notBefore: new Date(now.getTime() + DAY) }));
    await registerDeviceCert(h.db, "ad", cert({ commonName: "geraet-d", fingerprint: fp("d"), userId: "lk" }));
    const id = await registerDeviceCert(h.db, "ad", cert({ commonName: "geraet-e", fingerprint: fp("e") }));
    await revokeDeviceCert(h.db, "ad", "intern", id, "verloren", now);
  });

  it("gültig / fehlt / unbekannt / abgelaufen / noch nicht gültig / gesperrt", async () => {
    expect(await certCheck(h.db, fp("a"), "lk", now)).toBe("gueltig");
    expect(await certCheck(h.db, null, "lk", now)).toBe("fehlt");
    expect(await certCheck(h.db, fp("f"), "lk", now)).toBe("ungueltig");
    expect(await certCheck(h.db, fp("b"), "lk", now)).toBe("ungueltig");
    expect(await certCheck(h.db, fp("c"), "lk", now)).toBe("ungueltig");
    expect(await certCheck(h.db, fp("e"), "lk", now)).toBe("ungueltig");
  });

  it("an ein Konto gebunden: gilt nur für dieses Konto", async () => {
    expect(await certCheck(h.db, fp("d"), "lk", now)).toBe("gebunden");
    expect(await certCheck(h.db, fp("d"), "lk2", now)).toBe("ungueltig");
  });

  it("Übersicht: gültige zuerst, Status je Zeile, gebundenes Konto mit Namen", async () => {
    const list = await listDeviceCerts(h.db, now);
    expect(list.map((c) => c.status)).toEqual(["gueltig", "gueltig", "noch-nicht-gueltig", "abgelaufen", "gesperrt"]);
    expect(list.find((c) => c.commonName === "geraet-d")?.user?.name).toBe("Konto lk");
    expect(list.find((c) => c.status === "gesperrt")?.revokeReason).toBe("verloren");
  });

  it("Sperren: nur im Schulnetz, nur mit Grund, nicht doppelt; Audit", async () => {
    const id = await registerDeviceCert(h.db, "ad", cert({ commonName: "geraet-g", fingerprint: fp("1") }));
    await expect(revokeDeviceCert(h.db, "ad", "alles", id, "verloren", now)).rejects.toThrow(/nur im Schulnetz/);
    await expect(revokeDeviceCert(h.db, "ad", "geraet", id, "verloren", now)).rejects.toThrow(DeviceCertError);
    await expect(revokeDeviceCert(h.db, "ad", "intern", id, "weil" as "verloren", now)).rejects.toThrow(/Grund/);
    expect(await certCheck(h.db, fp("1"), "lk", now)).toBe("gueltig");
    await revokeDeviceCert(h.db, "ad", "intern", id, "kompromittiert", now);
    expect(await certCheck(h.db, fp("1"), "lk", now)).toBe("ungueltig");
    await expect(revokeDeviceCert(h.db, "ad", "intern", id, "verloren", now)).rejects.toThrow(/bereits gesperrt/);
    await expect(revokeDeviceCert(h.db, "ad", "intern", "gibt-es-nicht", "verloren", now)).rejects.toThrow(/nicht gefunden/);
    const logged = await h.db.select().from(auditLog).where(eq(auditLog.target, id));
    expect(logged.map((l) => l.action).sort()).toEqual(["verwaltung.geraet.ausgestellt", "verwaltung.geraet.gesperrt"]);
  });

  it("Fingerabdruck nur in Caddy-Form (64 Hex klein)", async () => {
    await expect(registerDeviceCert(h.db, "ad", cert({ fingerprint: "AA".repeat(32) }))).rejects.toThrow(/Fingerabdruck/);
  });
});

describe("Schuleinstellungen", () => {
  it("Vorgabe: Pflicht an, sobald die CA eingerichtet ist; Verwaltung/Admin gesperrt", async () => {
    expect(await readExternalSettings(h.db)).toEqual({ staffCert: null, adminAllowed: null });
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    expect(await readExternalPolicy(h.db)).toEqual({ staffCertRequired: true, adminAllowed: false });
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "aus");
    expect(await readExternalPolicy(h.db)).toEqual({ staffCertRequired: false, adminAllowed: false });
  });

  it("ändern nur im Schulnetz; zurück auf Vorgabe löscht die Einstellung", async () => {
    await expect(saveExternalSettings(h.db, "ad", "alles", { staffCert: "aus", adminAllowed: true })).rejects.toThrow(/nur im Schulnetz/);
    await saveExternalSettings(h.db, "ad", "intern", { staffCert: "an", adminAllowed: true });
    expect(await readExternalSettings(h.db)).toEqual({ staffCert: "an", adminAllowed: true });
    await saveExternalSettings(h.db, "ad", "intern", { staffCert: null, adminAllowed: null });
    expect(await readExternalSettings(h.db)).toEqual({ staffCert: null, adminAllowed: null });
  });
});

describe("externalAccessFor – Prüfung je Anfrage aus den Kennzeichen", () => {
  it("Schulnetz (ohne Kennzeichen) immer, ohne Blick auf mitgeschickte Geräte-Header", async () => {
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    for (const id of ["lk", "ad", "el"]) expect((await externalAccessFor(h.db, hdr({ [DEVICE_CERT_HEADER]: fp("e") }), { id, role: id === "lk" ? "lehrkraft" : id === "ad" ? "admin" : "eltern" }, now)).allowed).toBe(true);
  });

  it("mit CA: Lehrkraft von außen nur mit gültigem Zertifikat; gefälschte/gesperrte/fremde Fingerabdrücke zählen nicht", async () => {
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    const lk = { id: "lk", role: "lehrkraft" };
    expect((await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp("a") }), lk, now)).allowed).toBe(true);
    expect((await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "alles", [DEVICE_CERT_HEADER]: fp("a") }), lk, now)).allowed).toBe(true);
    expect(await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "alles" }), lk, now)).toEqual({ allowed: false, reason: "zertifikat" });
    expect(await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp("e") }), lk, now)).toEqual({ allowed: false, reason: "zertifikat" });
    // Großschreibung/Länge falsch → kein Fingerabdruck → „geraet“ fällt auf „nur öffentliche Seiten“ zurück
    expect(await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: "A".repeat(64) }), lk, now)).toEqual({ allowed: false, reason: "kein-zugang" });
    expect(await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "1", [DEVICE_CERT_HEADER]: fp("a") }), lk, now)).toEqual({ allowed: false, reason: "kein-zugang" });
  });

  it("Admin von außen gesperrt, selbst mit gültigem Zertifikat; Eltern im Modus „alles“ ohne Zertifikat", async () => {
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    expect(await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp("a") }), { id: "ad", role: "admin" }, now)).toEqual({ allowed: false, reason: "rolle" });
    expect((await externalAccessFor(h.db, hdr({ [EXTERN_HEADER]: "alles" }), { id: "el", role: "eltern" }, now)).allowed).toBe(true);
  });
});

describe("Anmeldung von außen (Better-Auth, Session-Hook)", () => {
  it("Admin/Verwaltung von außen: Ablehnung wie bei falschem Passwort, keine Sitzung; im Schulnetz normal", async () => {
    const auth = createAuth(h.db);
    for (const username of ["konto.ad", "konto.vw"]) {
      await expect(auth.api.signInUsername({ body: { username, password: "geheim123" }, headers: hdr({ [EXTERN_HEADER]: "alles" }) })).rejects.toThrow(/Benutzername oder Passwort ist falsch/);
    }
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "ad"))).toHaveLength(0);
    expect((await auth.api.signInUsername({ body: { username: "konto.ad", password: "geheim123" }, headers: hdr({}) }))?.token).toBeTruthy();
  });

  it("Lehrkraft mit CA: ohne Zertifikat abgelehnt, mit gültigem angemeldet; Eltern im Modus „alles“ angemeldet", async () => {
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    const auth = createAuth(h.db);
    await expect(auth.api.signInUsername({ body: { username: "konto.pe", password: "geheim123" }, headers: hdr({ [EXTERN_HEADER]: "alles" }) })).rejects.toThrow();
    await expect(
      auth.api.signInUsername({ body: { username: "konto.pe", password: "geheim123" }, headers: hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp("e") }) }),
    ).rejects.toThrow();
    expect((await auth.api.signInUsername({ body: { username: "konto.pe", password: "geheim123" }, headers: hdr({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp("a") }) }))?.token).toBeTruthy();
    expect((await auth.api.signInUsername({ body: { username: "konto.el", password: "geheim123" }, headers: hdr({ [EXTERN_HEADER]: "alles" }) }))?.token).toBeTruthy();
  });
});

describe("Ausstellung über die Schul-CA (nachgebaute step-ca)", () => {
  let ca: FakeStepCa;
  let cfg: StepCaConfig;
  beforeAll(async () => {
    ca = await fakeStepCa();
    cfg = { url: "https://step-ca:9000", provisioner: ca.provisioner, password: ca.password, rootPem: ca.root.pem };
  });
  afterEach(() => (ca.tamper = undefined));
  const input = { label: "iPad Lehrerzimmer 3", days: 365, organization: "Gesamtschule am Lindenhof" };

  it("stellt aus, trägt ein (gilt sofort) und liefert .p12 + .mobileconfig mit einmaligem Passwort", async () => {
    vi.stubEnv("SCHULOS_DEVICE_CERTS", "an");
    const r = await issueDeviceCert(h.db, "ad", "intern", { ...input, username: "Konto.LK" }, cfg, ca.transport, now);
    expect(r.commonName).toMatch(/^geraet-[0-9a-f]{12}$/);
    expect(ca.signed.at(-1)).toEqual({ commonName: r.commonName, notAfter: new Date(now.getTime() + 365 * DAY).toISOString() });
    const [row] = await h.db.select().from(deviceCerts).where(eq(deviceCerts.id, r.id));
    expect(row).toMatchObject({ label: "iPad Lehrerzimmer 3", commonName: r.commonName, fingerprint: r.fingerprint, userId: "lk", createdBy: "ad", revokedAt: null });
    expect(() => createSecureContext({ pfx: r.p12, passphrase: r.password })).not.toThrow();
    expect(r.mobileconfig.toString("utf8")).toContain(r.p12.toString("base64").slice(0, 60));
    // Fingerabdruck wie Caddy: SHA-256 über DER, klein
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await certCheck(h.db, r.fingerprint, "lk", new Date())).toBe("gebunden");
    expect(await certCheck(h.db, r.fingerprint, "lk2", new Date())).toBe("ungueltig");
    expect(JSON.stringify(row)).not.toContain(r.password);
  });

  it("fingerprintOf entspricht dem Doppelpunkt-Format von OpenSSL", () => {
    const x = new X509Certificate(ca.root.pem);
    expect(fingerprintOf(x)).toBe(x.fingerprint256.replace(/:/g, "").toLowerCase());
  });

  it("nur im Schulnetz, Bezeichnung und Laufzeit geprüft, Bindung nur an Personal", async () => {
    await expect(issueDeviceCert(h.db, "ad", "alles", input, cfg, ca.transport, now)).rejects.toThrow(/nur im Schulnetz/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, label: "x" }, cfg, ca.transport, now)).rejects.toThrow(/Gerätebezeichnung/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, label: "<script>" }, cfg, ca.transport, now)).rejects.toThrow(/Gerätebezeichnung/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, days: 731 }, cfg, ca.transport, now)).rejects.toThrow(/Laufzeit/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, days: 29 }, cfg, ca.transport, now)).rejects.toThrow(/Laufzeit/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, username: "konto.el" }, cfg, ca.transport, now)).rejects.toThrow(/nur an Konten/);
    await expect(issueDeviceCert(h.db, "ad", "intern", { ...input, username: "niemand" }, cfg, ca.transport, now)).rejects.toThrow(/Kein aktives Konto/);
  });

  it("Antwort der CA wird geprüft: fremder Schlüssel, anderer Name, Fehler → nichts eingetragen", async () => {
    const before = (await h.db.select().from(deviceCerts)).length;
    ca.tamper = "fremder-schluessel";
    await expect(issueDeviceCert(h.db, "ad", "intern", input, cfg, ca.transport, now)).rejects.toThrow(/fremden Schlüssel/);
    ca.tamper = "anderer-name";
    await expect(issueDeviceCert(h.db, "ad", "intern", input, cfg, ca.transport, now)).rejects.toThrow(/anderen Namen/);
    ca.tamper = "fehler";
    await expect(issueDeviceCert(h.db, "ad", "intern", input, cfg, ca.transport, now)).rejects.toThrow(StepCaError);
    expect((await h.db.select().from(deviceCerts)).length).toBe(before);
  });

  it("falsches Provisioner-Passwort bzw. unbekannter Provisioner → verständlicher Fehler", async () => {
    await expect(issueDeviceCert(h.db, "ad", "intern", input, { ...cfg, password: "falsch" }, ca.transport, now)).rejects.toThrow(/Provisioner-Passwort/);
    await expect(issueDeviceCert(h.db, "ad", "intern", input, { ...cfg, provisioner: "anderer" }, ca.transport, now)).rejects.toThrow(/Provisioner „anderer“/);
  });
});

describe("geraete-ca-pruefen (CLI) und Konfiguration aus der Umgebung", () => {
  it("prüft Ausstellung, Kette und Laufzeit gegen die Wurzel im CA-Verzeichnis; ohne Einrichtung verständlicher Fehler", async () => {
    const ca = await fakeStepCa();
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-ca-"));
    writeFileSync(path.join(dir, "root_ca.crt"), ca.root.pem);
    const env = { SCHULOS_DEVICE_CERTS: "an", SCHULOS_DEVICE_CA_DIR: dir, SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD: ca.password };
    const ok = await checkDeviceCa(env, ca.transport);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // fremde Wurzel im Verzeichnis → Kette endet nicht an der Schul-CA
    writeFileSync(path.join(dir, "root_ca.crt"), makeCert({ cn: "Andere CA", ca: true }).pem);
    expect(await checkDeviceCa(env, ca.transport)).toMatchObject({ ok: false, error: expect.stringContaining("Wurzel") });
    expect(await checkDeviceCa({ ...env, SCHULOS_DEVICE_CERTS: "aus" }, ca.transport)).toMatchObject({ ok: false, error: expect.stringContaining("nicht eingerichtet") });
    expect(await checkDeviceCa({ ...env, SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD: "" }, ca.transport)).toMatchObject({ ok: false, error: expect.stringContaining("PROVISIONER_PASSWORD") });
    expect(await checkDeviceCa({ ...env, SCHULOS_DEVICE_CA_DIR: path.join(dir, "fehlt") }, ca.transport)).toMatchObject({ ok: false, error: expect.stringContaining("Wurzelzertifikat") });
    rmSync(dir, { recursive: true, force: true });
  });
});
