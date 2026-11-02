import { describe, expect, it } from "vitest";
import { emptyAgentState } from "@schulos/server/agent-api";
import { certCheckText, dockerExposureProblem, formatBytes, formatStatus, parseArgs, parseComposePs, parseDf, redactLog, sanitizeEnv, UsageError } from "./core";

describe("Aufruf", () => {
  it("Befehle, Installationsordner, Optionen", () => {
    expect(parseArgs([])).toEqual({ dir: "/opt/schulos", command: { name: "help" } });
    expect(parseArgs(["status"], { SCHULOS_DIR: "/srv/x" })).toEqual({ dir: "/srv/x", command: { name: "status", json: false } });
    expect(parseArgs(["--dir", "/a", "backup", "now"])).toEqual({ dir: "/a", command: { name: "backup-now" } });
    expect(parseArgs(["reset-admin"]).command).toEqual({ name: "reset-admin" });
    expect(parseArgs(["reset-admin", "chef"]).command).toEqual({ name: "reset-admin", username: "chef" });
    expect(parseArgs(["schulnetz-zuruecksetzen"]).command).toEqual({ name: "schulnetz-zuruecksetzen" });
    expect(() => parseArgs(["schulnetz-zuruecksetzen", "x"])).toThrow(UsageError);
    expect(parseArgs(["demo-reset", "--yes"]).command).toEqual({ name: "demo-reset", yes: true });
    expect(parseArgs(["update", "--check", "--kanal", "beta", "--quelle", "/media/usb"]).command).toEqual({
      name: "update",
      check: true,
      yes: false,
      skipBackup: false,
      channel: "beta",
      source: "/media/usb",
    });
    expect(parseArgs(["support-bundle", "--out", "/tmp/b.tgz"]).command).toEqual({ name: "support-bundle", out: "/tmp/b.tgz" });
    expect(parseArgs(["status", "--help"]).command).toEqual({ name: "help" });
    expect(parseArgs(["test-restore"]).command).toEqual({ name: "test-restore" });
    expect(parseArgs(["db-rolle"]).command).toEqual({ name: "db-rolle" });
    expect(() => parseArgs(["db-rolle", "x"])).toThrow(UsageError);
    expect(parseArgs(["wartungsfenster"]).command).toEqual({ name: "wartungsfenster" });
    expect(parseArgs(["system-sync"]).command).toEqual({ name: "system-sync" });
    expect(parseArgs(["vorschau", "an", "--domain", "v.schule.de"]).command).toEqual({ name: "vorschau", action: "an", domain: "v.schule.de" });
    expect(() => parseArgs(["vorschau", "weg"])).toThrow("schulosctl vorschau an");
    // GATE-4c: von außen nur ausdrücklich
    expect(parseArgs(["vorschau", "an"]).command).toEqual({ name: "vorschau", action: "an" });
    expect(parseArgs(["vorschau", "an", "--extern"]).command).toEqual({ name: "vorschau", action: "an", extern: true });
    expect(() => parseArgs(["vorschau", "reset", "--extern"])).toThrow("--extern nur mit");
    // Q-4E-28: Schulprofil in die Vorschau übernehmen bzw. wieder entfernen
    expect(parseArgs(["vorschau", "profil"]).command).toEqual({ name: "vorschau", action: "profil" });
    expect(parseArgs(["vorschau", "profil", "--aus"]).command).toEqual({ name: "vorschau", action: "profil", off: true });
    expect(() => parseArgs(["vorschau", "an", "--aus"])).toThrow("--aus nur mit");
    expect(parseArgs(["bundle", "create", "1.4.2", "1.5.0", "--out", "/media/usb/b.tar"]).command).toEqual({ name: "bundle", action: "create", versions: ["1.4.2", "1.5.0"], out: "/media/usb/b.tar" });
    expect(parseArgs(["bundle", "import", "b.tar"]).command).toEqual({ name: "bundle", action: "import", file: "b.tar" });
    expect(() => parseArgs(["bundle", "create"])).toThrow("bundle create <version");
  });

  it("Fehler verständlich", () => {
    expect(() => parseArgs(["backup"])).toThrow("schulosctl backup now");
    expect(() => parseArgs(["rollback"])).toThrow(UsageError);
    expect(() => parseArgs(["update", "--kanal", "nightly"])).toThrow("--kanal: stabil oder beta");
    expect(() => parseArgs(["status", "extra"])).toThrow("Unerwartet: extra");
    expect(() => parseArgs(["--dir"])).toThrow("--dir braucht einen Wert");
  });

  it("CA-06: zertifikat-pruefen", () => {
    expect(parseArgs(["zertifikat-pruefen"]).command).toEqual({ name: "zertifikat-pruefen", waitSeconds: 0, staging: false });
    expect(parseArgs(["zertifikat-pruefen", "--warten", "1500", "--staging"]).command).toEqual({ name: "zertifikat-pruefen", waitSeconds: 1500, staging: true });
    expect(() => parseArgs(["zertifikat-pruefen", "--warten", "bald"])).toThrow("--warten: Sekunden");
    expect(() => parseArgs(["zertifikat-pruefen", "x"])).toThrow("Unerwartet: x");
  });
});

describe("CA-06: Abschlussprüfung des Zertifikats", () => {
  const o = { domain: "schulos.schule-xy.de", acme: true, dns: "hetzner", staging: false };
  const cert = { expiresAt: "2027-01-31T10:00:00.000Z", issuer: "Let's Encrypt R12", trusted: true, nameOk: true, problem: null };

  it("öffentlich gültig → ok; eigene CA → nichts zu prüfen", () => {
    expect(certCheckText(cert, o)).toEqual({ ok: true, text: "schulos.schule-xy.de: öffentliches Zertifikat von Let's Encrypt R12, gültig bis 2027-01-31 ✓" });
    expect(certCheckText(null, { ...o, acme: false, dns: null }).ok).toBe(true);
  });

  it("kein bzw. nicht vertrauenswürdiges Zertifikat → Hinweise je Prüfart", () => {
    const none = certCheckText(null, o);
    expect(none.ok).toBe(false);
    expect(none.text).toContain("noch kein Zertifikat");
    expect(none.text).toContain("DNS-Prüfung (hetzner)");
    expect(certCheckText(null, { ...o, dns: null }).text).toContain("Port 80 aus dem Internet");
    const self = certCheckText({ ...cert, issuer: "Caddy Local Authority", trusted: false, problem: "SELF_SIGNED_CERT_IN_CHAIN" }, o);
    expect(self).toMatchObject({ ok: false });
    expect(self.text).toContain("nicht öffentlich vertrauenswürdig (SELF_SIGNED_CERT_IN_CHAIN)");
  });

  it("Staging: Testzertifikat zählt nur mit --staging und passendem Namen", () => {
    const staging = { ...cert, issuer: "(STAGING) Let's Encrypt (STAGING) Counterfeit Cashew R10", trusted: false, problem: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" };
    expect(certCheckText(staging, o).ok).toBe(false);
    expect(certCheckText(staging, { ...o, staging: true })).toMatchObject({ ok: true });
    expect(certCheckText({ ...staging, nameOk: false, problem: "Name passt nicht" }, { ...o, staging: true }).ok).toBe(false);
  });
});

describe("Status", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  const services = parseComposePs(
    [
      '{"Service":"app","State":"running","Health":"healthy"}',
      '{"Service":"caddy","State":"running","Health":""}',
      '{"Service":"db","State":"running","Health":"healthy"}',
    ].join("\n"),
  );
  const app = { version: "1.4.2", instance: "production", database: "postgres", migrations: 38, accounts: { admin: 1, lehrkraft: 20 } };
  const backup = {
    ...emptyAgentState("i1"),
    lastOkAt: "2026-10-05T00:31:00Z",
    lastRun: { trigger: "zeitplan" as const, status: "ok" as const, startedAt: "x", finishedAt: "2026-10-05T00:31:00Z" },
  };

  it("compose ps: Zeilen- und Array-Format", () => {
    expect(services.map((s) => s.service)).toEqual(["app", "caddy", "db"]);
    expect(parseComposePs('[{"Name":"x-app-1","State":"exited"}]')).toEqual([{ service: "x-app-1", state: "exited", health: "" }]);
    expect(parseComposePs("")).toEqual([]);
  });

  it("alles in Ordnung", () => {
    const r = formatStatus({ services, app, backup, disk: { usedPercent: 41, freeBytes: 120 * 1024 ** 3 }, now });
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe("Zustand: in Ordnung");
    expect(r.lines.join("\n")).toContain("SchulOS 1.4.2 · Instanz production · Datenbank postgres (38 Migrationen) · 21 Konten");
    expect(r.lines.join("\n")).toContain("✓ gesichert – letzte Sicherung 05.10.26, 02:31");
    expect(r.lines.join("\n")).toContain("41 % belegt, 120 GB frei");
  });

  it("Probleme werden oben zusammengefasst", () => {
    const r = formatStatus({
      services: [{ service: "app", state: "running", health: "unhealthy" }],
      app: null,
      backup: { ...backup, lastOkAt: "2026-10-03T00:31:00Z" },
      disk: { usedPercent: 93, freeBytes: 5 * 1024 ** 3 },
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe("Zustand: ACHTUNG – App antwortet nicht; app: running/unhealthy; Backup überfällig; Speicherplatz knapp");
    expect(formatStatus({ services, app, backup: null, disk: null, now }).lines[0]).toContain("Backup nicht eingerichtet");
  });

  it("GATE-4c: Außenzugang mit Userland-Proxy wird gemeldet", () => {
    expect(dockerExposureProblem(null, "keiner")).toBeNull();
    expect(dockerExposureProblem(null, undefined)).toBeNull();
    expect(dockerExposureProblem('{"userland-proxy": false}', "alles")).toBeNull();
    expect(dockerExposureProblem('{"live-restore": true}', "oeffentliche-seiten")).toContain("userland-proxy");
    expect(dockerExposureProblem(null, "alles")).toContain("IPv6");
    expect(dockerExposureProblem("kaputt", "alles")).not.toBeNull();
    const r = formatStatus({ services, app, backup, disk: null, now, exposure: dockerExposureProblem(null, "alles") });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain("Außenzugang über IPv6 offen");
  });

  it("df und Bytes", () => {
    expect(parseDf("Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 410 590 41% /\n")).toEqual({ usedPercent: 41, freeBytes: 590 });
    expect(parseDf("kaputt")).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
  });
});

describe("Support-Bundle ohne Personendaten", () => {
  it("Konfiguration: Geheimnisse und Angaben zur Schule geschwärzt", () => {
    const env = [
      "POSTGRES_PASSWORD=geheim",
      "SCHULOS_DOMAIN=schulos.gs-musterstadt.de",
      "SCHULOS_INSTANCE=production",
      "SCHULOS_ADMIN_USERNAME=m.mueller",
      "export BETTER_AUTH_SECRET=abc",
      "# Kommentar bleibt",
      "SCHULOS_HTTP_PORT=80",
    ].join("\n");
    expect(sanitizeEnv(env)).toBe(
      [
        "POSTGRES_PASSWORD=***",
        "SCHULOS_DOMAIN=***",
        "SCHULOS_INSTANCE=production",
        "SCHULOS_ADMIN_USERNAME=***",
        "export BETTER_AUTH_SECRET=***",
        "# Kommentar bleibt",
        "SCHULOS_HTTP_PORT=80",
      ].join("\n"),
    );
  });

  it("CA-06: Zugang zum DNS-Anbieter und ACME-E-Mail geschwärzt, Anbieter und Modus lesbar", () => {
    const env = [
      "SCHULOS_TLS=it@schule.de",
      "SCHULOS_TLS_DNS=netcup",
      "SCHULOS_DNS_USER=12345",
      "SCHULOS_DNS_TOKEN=abc",
      "SCHULOS_DNS_SECRET='x$y'",
      "SCHULOS_DNS_SERVER=ns1.schule.de:53",
      "SCHULOS_DNS_RESOLVERS=9.9.9.9 1.1.1.1",
    ].join("\n");
    expect(sanitizeEnv(env).split("\n")).toEqual([
      "SCHULOS_TLS=***",
      "SCHULOS_TLS_DNS=netcup",
      "SCHULOS_DNS_USER=***",
      "SCHULOS_DNS_TOKEN=***",
      "SCHULOS_DNS_SECRET=***",
      "SCHULOS_DNS_SERVER=***",
      "SCHULOS_DNS_RESOLVERS=9.9.9.9 1.1.1.1",
    ]);
    expect(sanitizeEnv("SCHULOS_TLS=internal")).toBe("SCHULOS_TLS=internal");
  });

  it("Logs: E-Mail, IP, Token, Namen, Zufallswerte", () => {
    const log = [
      "[schulos] Erststart Produktiv: leere Instanz mit Admin-Konto „m.mueller“ angelegt",
      'login failed username=jana.brandt from 192.168.10.20 ua="Mozilla"',
      "mail an eltern.schaefer@example.org versendet",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      "session 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a gesetzt",
      "listening on 127.0.0.1:3000 und fe80::1:2:3 um 04:10:05",
      'caddy {"remote_ip":"10.0.0.7","uri":"/api/health"}',
      "image sha256 " + "a".repeat(64),
    ].join("\n");
    const r = redactLog(log);
    expect(r).not.toMatch(/m\.mueller|jana\.brandt|192\.168|eltern\.schaefer|eyJhbG|3f9a8b7c|10\.0\.0\.7|fe80/);
    expect(r).toContain("Admin-Konto „<name>“");
    expect(r).toContain("username=<…>");
    expect(r).toContain("<email>");
    expect(r).toContain("Bearer <token>");
    expect(r).toContain("127.0.0.1:3000");
    expect(r).toContain("um 04:10:05");
    expect(r).toContain('"uri":"/api/health"');
    expect(r).toContain("a".repeat(64)); // Digests bleiben (Versionen nachvollziehbar)
  });

  it("CA-01: PEM-Blöcke (CA-Schlüssel, auch abgeschnitten) kommen nie ins Diagnosepaket", () => {
    const key = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIGEHEIM\nzeile2\n-----END EC PRIVATE KEY-----";
    const r = redactLog(`vorher\n${key}\nnachher\n-----BEGIN PRIVATE KEY-----\nABGESCHNITTEN`);
    expect(r).toBe("vorher\n<pem EC PRIVATE KEY>\nnachher\n<pem PRIVATE KEY>");
  });
});
