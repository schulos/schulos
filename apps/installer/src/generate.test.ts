import { hashPassword, verifyPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { parseAdminConfig } from "@schulos/server/admin";
import { parseEnvFile } from "@schulos/server/config";
import { mailConfig } from "@schulos/server/mail";
import { normalizePairingCode } from "@schulos/server/pairing";
import { retentionFromEnv } from "@schulos/server/backup-retention";
import { readInstallYaml, resolve } from "./answers";
import { BACKUP, PRODUCTION } from "./fixtures";
import { generate, summarize, wartungDropin, type GenerateDeps, type InstallPlan } from "./generate";
import { rcloneReveal } from "./rclone";

const deps: GenerateDeps = { hashPassword, randomSecret: () => "zufall-0123456789abcdef", pairingCode: () => "AB12-CD34-EF56", now: new Date("2026-10-05T08:00:00Z") };

function file(plan: InstallPlan, suffix: string): { content: string; mode: number } {
  const f = plan.files.find((x) => x.path.endsWith(suffix));
  if (!f) throw new Error(`${suffix} fehlt: ${plan.files.map((x) => x.path).join(", ")}`);
  return f;
}
const env = (plan: InstallPlan, suffix: string) => parseEnvFile(file(plan, suffix).content);

describe("Konfiguration erzeugen – Hauptsystem", () => {
  it("Produktiv: Admin nur als Hash (verifizierbar), Schule, Compose-Variablen, Kopplung nur im Plan", async () => {
    const plan = await generate(PRODUCTION, deps);
    expect(plan).toMatchObject({ role: "main", stackDir: "/opt/schulos", composeSource: "compose.yaml" });
    expect(plan.files.map((f) => [f.path, f.mode])).toEqual([
      ["/opt/schulos/.env", 0o600],
      ["/opt/schulos/schulos.env", 0o600],
      ["/etc/systemd/system/schulos-wartung.timer.d/fenster.conf", 0o644],
      ["/etc/schulos/schulos-install.yaml", 0o600],
    ]);
    expect(env(plan, "/.env")).toEqual({
      POSTGRES_PASSWORD: "zufall-0123456789abcdef",
      POSTGRES_ADMIN_PASSWORD: "zufall-0123456789abcdef",
      SCHULOS_DOMAIN: "schulos.gs-musterstadt.de",
      SCHULOS_TLS: "internal",
      SCHULOS_PUBLIC_ACCESS: "keiner",
      SCHULOS_CHANNEL: "stabil",
    });
    const app = env(plan, "schulos.env");
    expect(app).toMatchObject({
      SCHULOS_INSTANCE: "production",
      SCHULOS_SCHOOL_NAME: "Gesamtschule Musterstadt",
      SCHULOS_SCHOOL_NUMBER: "123456",
      SCHULOS_SCHOOL_STATE: "NW",
      SCHULOS_SCHOOL_FORM: "gesamtschule",
    });
    expect(app.SCHULOS_TEMPLATES).toBeUndefined();
    expect(app.SCHULOS_ADMIN_PASSWORD).toBeUndefined();
    // so liest es der Erststart der App
    const admin = parseAdminConfig(app);
    expect(admin).toMatchObject({ ok: true, admin: { username: "ina.tech", firstName: "Ina", lastName: "Tech" } });
    if (!admin.ok || !("hash" in admin.admin.password)) throw new Error("Hash erwartet");
    expect(await verifyPassword({ hash: admin.admin.password.hash, password: "Lange-Leitung-Kaffee-42" })).toBe(true);
    expect(mailConfig(app)).toBeNull();
    // Kopplungscode nur im Plan, normalisiert; in keiner Datei
    expect(plan.pairing).toEqual({ url: "https://backup.gs-musterstadt.de", code: "K7Q2-9MXA-4RT1" });
    for (const f of plan.files) for (const secret of ["K7Q2", "Lange-Leitung", "Wartung-im-Keller"]) expect(f.content).not.toContain(secret);
  });

  it("SEC-07: App-Rolle und Wartungsrolle bekommen verschiedene Passwörter", async () => {
    let n = 0;
    const plan = await generate(PRODUCTION, { ...deps, randomSecret: () => `zufall-${++n}` });
    const compose = env(plan, "/.env");
    expect(compose.POSTGRES_PASSWORD).toMatch(/^zufall-\d$/);
    expect(compose.POSTGRES_ADMIN_PASSWORD).toMatch(/^zufall-\d$/);
    expect(compose.POSTGRES_ADMIN_PASSWORD).not.toBe(compose.POSTGRES_PASSWORD);
  });

  it("Demo: nur Instanztyp, kein Admin, keine Kopplung; Let's Encrypt, beta, Proxy", async () => {
    const plan = await generate(
      {
        role: "main",
        instance: "demo",
        "disk.devices": ["/dev/vda"],
        "access.password": "Wartung-im-Keller-2026",
        "web.domain": "demo.schulos.de",
        "web.tls": "letsencrypt",
        "web.acme_email": "it@schulos.de",
        "updates.channel": "beta",
        "network.proxy": "http://proxy.schule.de:3128",
      },
      deps,
    );
    expect(env(plan, "/.env")).toMatchObject({ SCHULOS_TLS: "it@schulos.de", SCHULOS_CHANNEL: "beta" });
    expect(env(plan, "schulos.env")).toEqual({
      SCHULOS_INSTANCE: "demo",
      HTTPS_PROXY: "http://proxy.schule.de:3128",
      HTTP_PROXY: "http://proxy.schule.de:3128",
      NO_PROXY: "localhost,127.0.0.1,postgres,app,caddy,demo.schulos.de",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(plan.pairing).toBeUndefined();
  });

  it("Hinter vorhandenem Proxy: eigene CA, E-Mail mit Sonderzeichen landet korrekt in schulos.env", async () => {
    const plan = await generate(
      {
        ...PRODUCTION,
        "web.tls": "proxy",
        "school.templates": true,
        "mail.host": "smtp.schule.de",
        "mail.user": "schulos@schule.de",
        "mail.password": "pa$$ wort#1",
        "mail.from": "SchulOS <schulos@schule.de>",
        "mail.alarm_to": ["it@schule.de", "sl@schule.de"],
      },
      deps,
    );
    expect(file(plan, "/.env").content).toContain("# hinter vorhandenem Proxy");
    expect(env(plan, "/.env").SCHULOS_TLS).toBe("internal");
    expect(env(plan, "/.env").SCHULOS_TRUSTED_PROXIES).toBeUndefined();
    const app = env(plan, "schulos.env");
    expect(app.SCHULOS_TEMPLATES).toBe("1");
    expect(mailConfig(app)).toEqual({
      host: "smtp.schule.de",
      port: 587,
      secure: false,
      user: "schulos@schule.de",
      password: "pa$$ wort#1",
      from: "SchulOS <schulos@schule.de>",
      to: ["it@schule.de", "sl@schule.de"],
    });
  });

  it("Außenzugang (P4-40): öffentliche Seiten hinter dem Proxy des Schulträgers, mehrere Adressen durch Leerzeichen", async () => {
    const plan = await generate(
      { ...PRODUCTION, "web.tls": "proxy", "web.trusted_proxies": ["10.0.0.5", "fd00::/64"], "web.public_access": "oeffentliche-seiten" },
      deps,
    );
    expect(env(plan, "/.env")).toMatchObject({ SCHULOS_PUBLIC_ACCESS: "oeffentliche-seiten", SCHULOS_TRUSTED_PROXIES: "10.0.0.5 fd00::/64" });
    // Proxy-Adressen nur bei web.tls = proxy
    const le = await generate({ ...PRODUCTION, "web.tls": "letsencrypt", "web.acme_email": "it@schule.de", "web.trusted_proxies": ["10.0.0.5"] }, deps);
    expect(env(le, "/.env").SCHULOS_TRUSTED_PROXIES).toBeUndefined();
  });

  it("Wartungsfenster als Timer-Drop-in: erstes Viertel des Fensters", () => {
    expect(wartungDropin("02:00-04:00")).toContain("OnCalendar=\nOnCalendar=*-*-* 02:30:00\nRandomizedDelaySec=30min");
    expect(wartungDropin("23:30-00:30")).toContain("OnCalendar=*-*-* 23:45:00\nRandomizedDelaySec=15min");
    expect(() => wartungDropin("4-2")).toThrow();
  });

  it("unvollständige Antworten sind ein Fehler", async () => {
    await expect(generate({ role: "main", instance: "production" }, deps)).rejects.toThrow(/school.name/);
  });
});

describe("Konfiguration erzeugen – Backupserver", () => {
  it("Admin als Hash, Kopplungscode für das Hauptsystem, Aufbewahrung wie die Backup-App sie liest", async () => {
    const plan = await generate({ ...BACKUP, "retention.monthly": 6, "retention.reason": "Schulträger verlangt Halbjahresstände" }, deps);
    expect(plan).toMatchObject({ role: "backup", stackDir: "/opt/schulos-backup", composeSource: "compose.backup.yaml", pairingCode: "AB12-CD34-EF56" });
    expect(plan.files.map((f) => f.path)).toEqual(["/opt/schulos-backup/.env", "/opt/schulos-backup/backup.env", "/etc/schulos/schulos-install.yaml"]);
    expect(env(plan, "/.env")).toEqual({ SCHULOS_BACKUP_DOMAIN: "backup.gs-musterstadt.de", SCHULOS_TLS: "internal", RESTORE_TEST_DB_PASSWORD: "zufall-0123456789abcdef" });
    const app = env(plan, "backup.env");
    expect(parseAdminConfig(app)).toMatchObject({ ok: true });
    expect(normalizePairingCode(app.SCHULOS_INITIAL_PAIRING_CODE!)).toBe("AB12CD34EF56");
    expect(retentionFromEnv(app)).toEqual({ retention: { daily: 14, weekly: 4, monthly: 6 }, reason: "Schulträger verlangt Halbjahresstände" });
    expect(app.SCHULOS_OFFSITE).toBeUndefined();
    expect(plan.offsiteHost).toBeUndefined();
  });

  it("Offsite SFTP: Passwort von rclone verschleiert, Host-Schlüssel per Datei; S3 mit Endpunkt", async () => {
    const sftp = await generate(
      { ...BACKUP, "offsite.type": "sftp", "offsite.host": "u123456.your-storagebox.de", "offsite.port": 23, "offsite.user": "u123456", "offsite.password": "Box'Pass$1" },
      deps,
    );
    const a = env(sftp, "backup.env");
    expect(a).toMatchObject({
      SCHULOS_OFFSITE: "offsite:schulos",
      RCLONE_CONFIG_OFFSITE_TYPE: "sftp",
      RCLONE_CONFIG_OFFSITE_HOST: "u123456.your-storagebox.de",
      RCLONE_CONFIG_OFFSITE_PORT: "23",
      RCLONE_CONFIG_OFFSITE_USER: "u123456",
      RCLONE_CONFIG_OFFSITE_KNOWN_HOSTS_FILE: "/srv/schulos-backup/config/offsite_known_hosts",
      RCLONE_CONFIG_OFFSITE_SHELL_TYPE: "none",
    });
    expect(rcloneReveal(a.RCLONE_CONFIG_OFFSITE_PASS!)).toBe("Box'Pass$1");
    expect(sftp.offsiteHost).toEqual({ host: "u123456.your-storagebox.de", port: 23 });

    const s3 = await generate(
      { ...BACKUP, "offsite.type": "s3", "offsite.endpoint": "https://s3.example.com", "offsite.access_key": "AKID", "offsite.secret_key": "geheim/+x", "offsite.path": "schule/backup" },
      deps,
    );
    expect(env(s3, "backup.env")).toMatchObject({
      SCHULOS_OFFSITE: "offsite:schule/backup",
      RCLONE_CONFIG_OFFSITE_TYPE: "s3",
      RCLONE_CONFIG_OFFSITE_PROVIDER: "Other",
      RCLONE_CONFIG_OFFSITE_ENDPOINT: "https://s3.example.com",
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: "AKID",
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: "geheim/+x",
    });
    expect(resolve({ ...BACKUP, "offsite.type": "s3" }).missing).toEqual(["offsite.endpoint", "offsite.access_key", "offsite.secret_key", "offsite.path"]);
  });

  it("exportierte Antworten: ohne Geheimnisse, für den nächsten Server wieder einlesbar", async () => {
    const plan = await generate({ ...BACKUP, "offsite.type": "sftp", "offsite.host": "box.de", "offsite.user": "u1", "offsite.password": "Box-Pass-1" }, deps);
    const yaml = file(plan, "schulos-install.yaml").content;
    expect(yaml).not.toMatch(/Box-Pass-1|Lange-Leitung|Wartung-im-Keller|AB12/);
    expect(resolve(readInstallYaml(yaml).answers).missing).toEqual(["access.password", "admin.password", "offsite.password"]);
  });
});

describe("Zusammenfassung", () => {
  it("Klartext je Frage, Geheimnisse verdeckt", () => {
    const lines = Object.fromEntries(summarize(PRODUCTION).map((l) => [l.id, l.value]));
    expect(lines).toMatchObject({
      role: "Hauptsystem",
      instance: "Produktiv (leer)",
      "school.state": "Nordrhein-Westfalen",
      "access.ssh": "nein",
      "admin.password": "••••••••",
      "backup.code": "••••••••",
      "disk.devices": "/dev/sda",
    });
  });
});
