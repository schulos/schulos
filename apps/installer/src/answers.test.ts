import { describe, expect, it } from "vitest";
import { readInstallYaml, resolve, writeInstallYaml } from "./answers";
import { BACKUP, CTX, GB, PRODUCTION } from "./fixtures";

describe("Antworten vervollständigen und prüfen", () => {
  it("Demo-Hauptsystem: fast alles hat Vorgaben – nur Rolle, Instanztyp und Wartungspasswort fehlen", () => {
    const r = resolve({ role: "main", instance: "demo" }, { ...CTX, disks: CTX.disks!.slice(0, 1) });
    expect(r.missing).toEqual(["access.password"]);
    expect(r.answers).toMatchObject({
      "locale.keyboard": "de",
      "locale.timezone": "Europe/Berlin",
      "disk.devices": ["/dev/sda"],
      "disk.encryption": "tpm2",
      "network.hostname": "schulos",
      "network.mode": "dhcp",
      "access.ssh": false,
      "updates.channel": "stabil",
      "updates.window": "02:00-04:00",
      "web.domain": "schulos.local",
      "web.tls": "internal",
      "backup.mode": "later",
    });
    // Demo: keine Schule, kein Admin, keine E-Mail
    expect(Object.keys(r.answers).some((k) => /^(school|admin|mail)\./.test(k))).toBe(false);
  });

  it("ohne Rolle wird nur gefragt, was für beide gilt", () => {
    const r = resolve({}, CTX);
    expect(r.missing).toEqual(["role", "disk.devices", "access.password", "web.domain"]);
    expect(r.complete).toBe(false);
  });

  it("Produktiv vollständig; Vorgaben für Bundesland, Schulform, Backup-Kopplung", () => {
    const r = resolve(PRODUCTION, CTX);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.answers).toMatchObject({ "school.state": "NW", "school.form": "gesamtschule", "school.templates": false, "backup.mode": "pair" });
    expect(r.warnings).toEqual([]);
  });

  it("Backupserver: zwei Platten = Spiegel (Vorgabe), Aufbewahrung 14/4/3, Offsite aus", () => {
    const r = resolve({ ...BACKUP, "disk.devices": [] }, CTX);
    expect(r.complete).toBe(true);
    expect(r.answers).toMatchObject({ "disk.devices": ["/dev/sda", "/dev/sdb"], "retention.daily": 14, "retention.weekly": 4, "retention.monthly": 3, "offsite.type": "off" });
    expect(r.answers["network.hostname"]).toBe("schulos-backup");
    expect(r.answers.instance).toBeUndefined();
  });

  it("Fehler je Frage: Platten, Verschlüsselung, Passwörter, Netz, Domain/TLS, Kopplungscode", () => {
    const r = resolve(
      {
        ...PRODUCTION,
        "disk.devices": ["/dev/sda", "/dev/sdb"],
        "disk.encryption": "none",
        "admin.password": "ina.tech-sicher-1234",
        "network.mode": "static",
        "network.address": "10.0.0.5/24",
        "network.gateway": "10.0.1.1",
        "network.dns": ["10.0.0.1", "dns.google"],
        "web.domain": "schulos.local",
        "web.tls": "letsencrypt",
        "backup.code": "zu-kurz",
        "school.number": "12345",
      },
      CTX,
    );
    const byId = Object.fromEntries(r.errors.map((e) => [e.id, e.message]));
    expect(byId).toMatchObject({
      "disk.devices": expect.stringContaining("genau eine Platte"),
      "disk.encryption": expect.stringContaining("Erlaubt"),
      "admin.password": expect.stringContaining("Benutzernamen"),
      "network.gateway": expect.stringContaining("nicht im Netz"),
      "network.dns": expect.stringContaining("dns.google"),
      "web.tls": expect.stringContaining("öffentliche Domain"),
      "backup.code": expect.stringContaining("12 Zeichen"),
      "school.number": expect.stringContaining("6 Ziffern"),
    });
    expect(r.complete).toBe(false);
  });

  it("Außenzugang (P4-40): Vorgabe „keiner“, Warnungen bei Proxy ohne Adresse, „alles“ und eigener CA", () => {
    expect(resolve(PRODUCTION, CTX).answers["web.public_access"]).toBe("keiner");
    expect(resolve(PRODUCTION, CTX).warnings.filter((w) => w.id === "web.public_access")).toEqual([]);
    const warn = (a: Record<string, unknown>) => resolve({ ...PRODUCTION, ...a } as typeof PRODUCTION, CTX).warnings.find((w) => w.id === "web.public_access")?.message ?? null;
    expect(warn({ "web.tls": "proxy" })).toMatch(/Ohne Adresse des Proxys gilt jede Anfrage als aus dem Schulnetz/);
    // GATE-4c: mit Außenzugang ist die Proxy-Adresse Pflicht (Fehler statt Warnung)
    const err = (a: Record<string, unknown>) => resolve({ ...PRODUCTION, ...a } as typeof PRODUCTION, CTX).errors.find((e) => e.id === "web.public_access")?.message ?? null;
    expect(err({ "web.tls": "proxy", "web.public_access": "oeffentliche-seiten" })).toMatch(/Adresse des Proxys Pflicht/);
    expect(err({ "web.tls": "proxy", "web.public_access": "alles" })).toMatch(/Adresse des Proxys Pflicht/);
    expect(err({ "web.tls": "proxy" })).toBeNull();
    expect(err({ "web.tls": "proxy", "web.trusted_proxies": ["10.0.0.5"], "web.public_access": "alles" })).toBeNull();
    expect(warn({ "web.tls": "proxy", "web.trusted_proxies": ["10.0.0.5"], "web.public_access": "oeffentliche-seiten" })).toBeNull();
    expect(warn({ "web.public_access": "alles" })).toMatch(/Zwei-Faktor/);
    expect(warn({ "web.public_access": "oeffentliche-seiten" })).toMatch(/Zertifikatswarnung/);
    const bad = resolve({ ...PRODUCTION, "web.tls": "proxy", "web.trusted_proxies": ["proxy.schule.de"], "web.public_access": "offen" }, CTX);
    expect(Object.fromEntries(bad.errors.map((e) => [e.id, e.message]))).toMatchObject({
      "web.trusted_proxies": expect.stringContaining("proxy.schule.de"),
      "web.public_access": expect.stringContaining("Erlaubt"),
    });
    // Backupserver: keine Frage zum Außenzugang
    expect(resolve(BACKUP, CTX).answers["web.public_access"]).toBeUndefined();
  });

  it("Platten gegen den Rechner prüfen: unbekannt, zu klein; ohne TPM2 keine TPM2-Verschlüsselung", () => {
    const r = resolve({ ...BACKUP, "disk.devices": ["/dev/sda", "/dev/sdc"], "disk.encryption": "tpm2" }, { ...CTX, tpm2: false });
    expect(r.errors.map((e) => e.id)).toEqual(["disk.devices", "disk.encryption"]);
    expect(r.errors[0]!.message).toMatch(/sdc ist zu klein/);
    expect(resolve({ ...BACKUP, "disk.devices": ["/dev/sdz"] }, CTX).errors[0]!.message).toMatch(/gibt es auf diesem Rechner nicht/);
    // ohne TPM2: Vorgabe Passphrase, die dann gefragt wird
    const p = resolve(BACKUP, { ...CTX, tpm2: false });
    expect(p.answers["disk.encryption"]).toBe("passphrase");
    expect(p.missing).toEqual(["disk.passphrase"]);
  });

  it("Passphrase: Hinweis auf Neustarts von Hand, mit TPM2 an Bord „TPM2 empfohlen“ (Q5-18)", () => {
    const warn = (a: Record<string, unknown>, ctx = CTX) => resolve({ ...BACKUP, ...a } as typeof BACKUP, ctx).warnings.find((w) => w.id === "disk.encryption")?.message ?? null;
    expect(warn({ "disk.encryption": "tpm2" })).toBeNull();
    expect(warn({ "disk.encryption": "passphrase", "disk.passphrase": "Platte-im-Keller-2026" })).toMatch(/^Neustarts nach Sicherheitsupdates nur von Hand.*TPM2 empfohlen$/);
    expect(warn({ "disk.passphrase": "Platte-im-Keller-2026" }, { ...CTX, tpm2: false })).toMatch(/Konsole ein$/);
  });

  it("Warnungen verhindern nichts: anderes Bundesland, Produktiv ohne Backup, ungleiche Spiegelplatten", () => {
    const main = resolve({ ...PRODUCTION, "school.state": "BY", "school.form": "realschule", "school.number": "0815", "backup.mode": "later" }, CTX);
    expect(main.complete).toBe(true);
    expect(main.warnings.map((w) => w.id)).toEqual(["school.state", "backup.mode"]);
    expect(main.warnings[0]!.message).toMatch(/nur für Nordrhein-Westfalen/);
    const ctx = { ...CTX, disks: [CTX.disks![0]!, { path: "/dev/sdb", sizeBytes: 250 * GB, model: "alt" }] };
    expect(resolve(BACKUP, ctx).warnings[0]!.message).toMatch(/nutzt nur 250 GB/);
  });

  it("Aufbewahrung über 3 Monate verlangt eine Begründung; E-Mail verlangt Absender und Empfänger", () => {
    const r = resolve({ ...BACKUP, "retention.monthly": 12, "mail.host": "smtp.schule.de", "mail.user": "backup@schule.de" }, CTX);
    expect(r.missing).toEqual(["mail.password", "mail.from", "mail.alarm_to", "retention.reason"]);
    expect(r.answers["mail.port"]).toBe(587);
  });

  it("Angaben, die nicht zur Rolle passen, fallen weg; unbekannte sind Fehler", () => {
    const r = resolve({ ...BACKUP, "school.name": "egal", instance: "demo", "netzwerk.hostname": "x" }, CTX);
    expect(r.answers["school.name"]).toBeUndefined();
    expect(r.answers.instance).toBeUndefined();
    expect(r.errors).toEqual([{ id: "netzwerk.hostname", message: "Unbekannte Angabe" }]);
  });
});

describe("schulos-install.yaml", () => {
  it("lesen: verschachtelt, Typen je Frage (ja/nein, Zahlen, Listen als Text)", () => {
    const { answers, errors } = readInstallYaml(`
# Schulträger: Vorlage für alle Gesamtschulen
role: main
instance: production
network:
  hostname: schulos-gs1
  mode: static
  address: 192.168.10.5/24
  gateway: 192.168.10.1
  dns: 192.168.10.1, 1.1.1.1
access:
  ssh: ja
  ssh_keys:
    - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsIDXR/63YbcH3XVTQfw1nDgH+dRYjXxKh6YShsVxjT it@traeger
school:
  number: 123456
  templates: true
mail:
  port: "465"
`);
    expect(errors).toEqual([]);
    expect(answers).toEqual({
      role: "main",
      instance: "production",
      "network.hostname": "schulos-gs1",
      "network.mode": "static",
      "network.address": "192.168.10.5/24",
      "network.gateway": "192.168.10.1",
      "network.dns": ["192.168.10.1", "1.1.1.1"],
      "access.ssh": true,
      "access.ssh_keys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsIDXR/63YbcH3XVTQfw1nDgH+dRYjXxKh6YShsVxjT it@traeger"],
      "school.number": "123456",
      "school.templates": true,
      "mail.port": 465,
    });
  });

  it("lesen: kaputte Datei, falsche Typen und unbekannte Schlüssel melden", () => {
    expect(readInstallYaml("role: [main").errors[0]!.message).toMatch(/Keine gültige YAML-Datei/);
    expect(readInstallYaml("- a\n- b").errors[0]!.message).toMatch(/role: main/);
    expect(readInstallYaml("").answers).toEqual({});
    const r = readInstallYaml("access:\n  ssh: vielleicht\nnetwork:\n  hostnam: x\nretention:\n  daily: viele\n");
    expect(r.errors).toEqual([
      { id: "network.hostnam", message: "Unbekannte Angabe" },
      { id: "access.ssh", message: "ja oder nein" },
      { id: "retention.daily", message: "Ganze Zahl" },
    ]);
  });

  it("schreiben ohne Passwörter, Schlüssel und Kopplungscode; wieder eingelesen fehlen genau die", () => {
    const full = resolve(PRODUCTION, CTX).answers;
    const text = writeInstallYaml(full);
    expect(text).toMatch(/^# SchulOS – Antworten des Installers \(ohne Passwörter\)/);
    for (const secret of ["Wartung-im-Keller-2026", "Lange-Leitung-Kaffee-42", "K7Q2", "k7q2"]) expect(text).not.toContain(secret);
    expect(text).toContain("school:\n  name: Gesamtschule Musterstadt");
    const again = resolve(readInstallYaml(text).answers, CTX);
    expect(again.errors).toEqual([]);
    expect(again.missing).toEqual(["access.password", "admin.password", "backup.code"]);
    expect({ ...again.answers, "access.password": "x", "admin.password": "x", "backup.code": "x" }).toEqual({
      ...full,
      "access.password": "x",
      "admin.password": "x",
      "backup.code": "x",
    });
  });
});
