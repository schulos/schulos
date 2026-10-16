// Die Fragen des Installers als Daten (INSTALLATION.md §3): Reihenfolge, Sichtbarkeit je Rolle/Instanztyp, Vorgaben und
// Prüfungen. Die TUI (B-41) stellt sie, `schulos-install.yaml` beantwortet sie vorab – beide gehen durch resolve().
import { checkPassword } from "@schulos/server/passwort";
import { normalizePairingCode } from "@schulos/server/pairing";
import { formsForState, isSchoolForm, isStateCode, STATES, type StateCode } from "../../../src/core/school/catalog";
import { LIMITS, preview } from "@schulos/server/backup-retention";
import { checkNet, SSH_PRIVATE_NETS } from "@schulos/server/ssh-netz";
import {
  checkHttpsUrl,
  checkProxyUrl,
  inSubnet,
  isDiskPath,
  isDomain,
  isEmail,
  isHostLabel,
  isIpOrCidr,
  isPublicDomain,
  isSender,
  isSshKey,
  parseCidr,
  parseIPv4,
  parseWindow,
} from "./checks";

export type Value = string | number | boolean | string[];
export type Answers = Record<string, Value>;

export interface Disk {
  path: string;
  sizeBytes: number;
  model: string;
}

/** Was der Installer über die Maschine weiß (Live-System); in Tests vorgegeben. */
export interface InstallContext {
  disks?: Disk[];
  tpm2?: boolean;
  /** SEC-09: Secure Boot aktiv (EFI-Variable SecureBoot); TPM2 gibt es nur damit – ohne wäre PCR 7 wertlos */
  secureBoot?: boolean;
  /** Einrichtung eines vorbereiteten Abbilds (qcow2, B-46) beim ersten Start: Rolle steht fest, Platte und Verschlüsselung auch */
  image?: "main" | "backup";
}

export type Kind = "text" | "password" | "select" | "bool" | "number" | "list" | "disks";

export interface Option {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  label: string;
  help?: string;
  kind: Kind;
  options?: (a: Answers, ctx: InstallContext) => Option[];
  /** nur fragen, wenn … (fehlt: immer) */
  when?: (a: Answers) => boolean;
  default?: (a: Answers, ctx: InstallContext) => Value | undefined;
  /** darf leer bleiben */
  optional?: boolean;
  /** Passwörter, Schlüssel, Kopplungscode: nie in die exportierte schulos-install.yaml */
  secret?: boolean;
  /** landet nicht wörtlich in einer env-Datei (gehasht, verschleiert oder nur im Systemschritt) – sonst gilt envSafe() */
  notInEnv?: boolean;
  /** betrifft Platte/Verschlüsselung – im vorbereiteten Abbild (ctx.image) schon erledigt, also nicht gefragt */
  hardware?: boolean;
  /** Fehlertext oder null */
  validate?: (v: Value, a: Answers, ctx: InstallContext) => string | null;
  /** Hinweis, der die Eingabe nicht verhindert */
  warn?: (v: Value, a: Answers, ctx: InstallContext) => string | null;
}

/** Mindestgröße einer Zielplatte (System + Images + Daten einer kleinen Schule) */
export const MIN_DISK_BYTES = 32 * 1024 ** 3;
/** Mindestlänge für Admin-, Wartungs- und Plattenpasswort im Installer (§3.2) – strenger als die allgemeine Regel */
export const INSTALL_PASSWORD_MIN = 12;
/** SEC-12: Vorgabe für „SSH nur aus diesen Netzen“ – die privaten Bereiche (Schulnetz, WireGuard-Tunnel) */
export { SSH_PRIVATE_NETS };

const isMain = (a: Answers) => a.role === "main";
/** SEC-09: TPM2 nur, wenn vorhanden und Secure Boot aktiv (unbekannt = erlaubt, z. B. Tests) */
const tpm2Usable = (ctx: InstallContext) => ctx.tpm2 !== false && ctx.secureBoot !== false;
const isBackup = (a: Answers) => a.role === "backup";
const isProduction = (a: Answers) => isMain(a) && a.instance === "production";
/** neu aufsetzen (Demo/Produktiv) – im Gegensatz zum Wiederherstellen (§4.4) */
const isFresh = (a: Answers) => isMain(a) && (a.instance === "demo" || a.instance === "production");
const isRestoreBackup = (a: Answers) => isMain(a) && a.instance === "restore-backup";
const isRestoreOffsite = (a: Answers) => isMain(a) && a.instance === "restore-offsite";
/** Konten gibt es im Produktiv-Hauptsystem und auf dem Backupserver – nicht in der Demo, beim Wiederherstellen kommen sie aus der Sicherung */
const hasAccounts = (a: Answers) => isProduction(a) || isBackup(a);
/** E-Mail-Einstellungen stehen in schulos.env, nicht in der Sicherung – beim Wiederherstellen also neu angeben */
const hasMail = (a: Answers) => hasAccounts(a) || isRestoreBackup(a) || isRestoreOffsite(a);
const isStatic = (a: Answers) => a["network.mode"] === "static";
/** Offsite-Angaben: Backupserver (Kopie einrichten) bzw. Hauptsystem „aus Offsite“ (Kopie lesen) */
const hasOffsite = (a: Answers) => isBackup(a) || isRestoreOffsite(a);
const offsite = (t: string) => (a: Answers) => hasOffsite(a) && a["offsite.type"] === t;
const offsiteOn = (a: Answers) => hasOffsite(a) && (a["offsite.type"] === "sftp" || a["offsite.type"] === "s3");
const mailOn = (a: Answers) => hasMail(a) && typeof a["mail.host"] === "string" && a["mail.host"] !== "";
const pairNow = (a: Answers) => (isFresh(a) && a["backup.mode"] === "pair") || isRestoreBackup(a);

const str = (v: Value) => (typeof v === "string" ? v : "");
const list = (v: Value) => (Array.isArray(v) ? v : []);
const gib = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`;

function strongPassword(v: Value, ctx: { username?: string; firstName?: string; lastName?: string } = {}): string | null {
  const s = str(v);
  if (s.length < INSTALL_PASSWORD_MIN) return `Mindestens ${INSTALL_PASSWORD_MIN} Zeichen.`;
  return checkPassword(s, ctx);
}

function port(v: Value): string | null {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535 ? null : "Zahl 1–65535";
}

const KEYBOARDS: Option[] = [
  { value: "de", label: "Deutsch" },
  { value: "de-nodeadkeys", label: "Deutsch (ohne Akzent-Tottasten)" },
  { value: "at", label: "Österreich" },
  { value: "ch", label: "Schweiz" },
  { value: "us", label: "US-Englisch" },
];

export const QUESTIONS: Question[] = [
  // §3.1 – beide Rollen
  { id: "locale.language", label: "Sprache", kind: "select", options: () => [{ value: "de", label: "Deutsch" }], default: () => "de" },
  { id: "locale.keyboard", label: "Tastatur", kind: "select", options: () => KEYBOARDS, default: () => "de" },
  {
    id: "locale.timezone",
    label: "Zeitzone",
    kind: "text",
    default: () => "Europe/Berlin",
    validate: (v) => (str(v) === "UTC" || Intl.supportedValuesOf("timeZone").includes(str(v)) ? null : "Zeitzone wie Europe/Berlin"),
  },
  {
    id: "role",
    label: "Rolle",
    help: "Hauptsystem = der SchulOS-Server der Schule · Backupserver = eigener Rechner für die Sicherungen (zuerst installieren)",
    kind: "select",
    options: () => [
      { value: "main", label: "Hauptsystem" },
      { value: "backup", label: "Backupserver" },
    ],
    default: (_a, ctx) => ctx.image,
    validate: (v, _a, ctx) =>
      ctx.image && v !== ctx.image ? `Dieses Abbild ist für ${ctx.image === "main" ? "das Hauptsystem (role: main)" : "den Backupserver (role: backup)"}` : null,
  },
  {
    id: "instance",
    label: "Instanztyp",
    help: "Demo = fiktive Schule zum Ausprobieren · Produktiv = leer bis auf das Admin-Konto. Demo lässt sich später nicht umwandeln.",
    kind: "select",
    when: isMain,
    options: () => [
      { value: "demo", label: "Demo (Gesamtschule am Lindenhof, keine echten Daten)" },
      { value: "production", label: "Produktiv (leer)" },
      { value: "restore-backup", label: "aus Backup wiederherstellen (neue Hardware)" },
      { value: "restore-offsite", label: "aus der Offsite-Kopie wiederherstellen (beide Server verloren)" },
    ],
  },
  {
    id: "disk.devices",
    hardware: true,
    label: "Zielplatte",
    help: "Wird vollständig gelöscht. Backupserver: zwei Platten werden gespiegelt (RAID 1).",
    kind: "disks",
    options: (_a, ctx) => (ctx.disks ?? []).map((d) => ({ value: d.path, label: `${d.path} · ${gib(d.sizeBytes)} · ${d.model}` })),
    default: (a, ctx) => {
      const disks = (ctx.disks ?? []).filter((d) => d.sizeBytes >= MIN_DISK_BYTES).map((d) => d.path);
      if (disks.length === 1) return disks;
      if (isBackup(a) && disks.length === 2) return disks;
      return undefined;
    },
    validate: (v, a, ctx) => {
      const paths = list(v);
      if (!paths.length) return "Mindestens eine Platte wählen";
      if (isMain(a) && paths.length > 1) return "Das Hauptsystem wird auf genau eine Platte installiert";
      if (paths.length > 2) return "Höchstens zwei Platten (Spiegel)";
      if (new Set(paths).size !== paths.length) return "Jede Platte nur einmal";
      for (const p of paths) {
        if (!isDiskPath(p)) return `„${p}“ ist kein Gerätepfad (/dev/…)`;
        if (!ctx.disks) continue;
        const d = ctx.disks.find((x) => x.path === p);
        if (!d) return `${p} gibt es auf diesem Rechner nicht`;
        if (d.sizeBytes < MIN_DISK_BYTES) return `${p} ist zu klein (${gib(d.sizeBytes)}, mindestens ${gib(MIN_DISK_BYTES)})`;
      }
      return null;
    },
    warn: (v, _a, ctx) => {
      const sizes = list(v).map((p) => ctx.disks?.find((d) => d.path === p)?.sizeBytes ?? 0);
      if (sizes.length === 2 && Math.min(...sizes) < 0.9 * Math.max(...sizes))
        return `Unterschiedlich große Platten: der Spiegel nutzt nur ${gib(Math.min(...sizes))}`;
      return null;
    },
  },
  {
    id: "disk.encryption",
    hardware: true,
    label: "Verschlüsselung",
    help: "TPM2 entsperrt automatisch auf dieser Hardware (nur mit Secure Boot) · TPM2 + PIN bzw. Passphrase bei jedem Start eingeben",
    kind: "select",
    options: (a, ctx) => [
      ...(tpm2Usable(ctx)
        ? [
            { value: "tpm2", label: "TPM2 (automatisch)" },
            { value: "tpm2-pin", label: "TPM2 + PIN beim Start" },
          ]
        : []),
      { value: "passphrase", label: "Passphrase beim Start" },
      ...(isMain(a) && a.instance === "demo" ? [{ value: "none", label: "aus (nur Demo)" }] : []),
    ],
    default: (_a, ctx) => (tpm2Usable(ctx) ? "tpm2" : "passphrase"),
    validate: (v, a, ctx) => {
      if (v === "none" && !(isMain(a) && a.instance === "demo")) return "Ohne Verschlüsselung nur für Demo-Instanzen";
      if ((v === "tpm2" || v === "tpm2-pin") && ctx.tpm2 === false) return "Dieser Rechner hat kein TPM2 – Passphrase wählen";
      // SEC-09: ohne Secure Boot misst PCR 7 nichts Verlässliches – TPM2 erst nach dem Einschalten im UEFI
      if ((v === "tpm2" || v === "tpm2-pin") && ctx.secureBoot === false) return "TPM2 nur mit Secure Boot – im UEFI einschalten oder Passphrase wählen";
      return null;
    },
    // Q5-18: mit Passphrase/PIN startet das Wartungsfenster nicht selbst neu (der Server hinge nachts an der Eingabe)
    warn: (v, _a, ctx) =>
      v === "passphrase" || v === "tpm2-pin"
        ? `Neustarts nach Sicherheitsupdates nur von Hand: SchulOS meldet sie in Verwaltung → System, jemand gibt die ${v === "tpm2-pin" ? "PIN" : "Passphrase"} an der Konsole ein${!tpm2Usable(ctx) || v === "tpm2-pin" ? "" : " – TPM2 empfohlen"}`
        : null,
  },
  {
    id: "disk.tpm_pin",
    hardware: true,
    label: "PIN für das TPM2",
    help: "Bei jedem Start einzugeben (mindestens 8 Zeichen); ohne sie hilft nur der Wiederherstellungsschlüssel",
    kind: "password",
    secret: true,
    notInEnv: true,
    when: (a) => a["disk.encryption"] === "tpm2-pin",
    validate: (v) => (str(v).length >= 8 ? null : "Mindestens 8 Zeichen"),
  },
  {
    id: "disk.passphrase",
    hardware: true,
    label: "Passphrase für die Platte",
    help: "Ohne sie startet der Server nicht – sicher aufbewahren",
    kind: "password",
    secret: true,
    notInEnv: true,
    when: (a) => a["disk.encryption"] === "passphrase",
    validate: (v) => strongPassword(v),
  },
  {
    id: "network.hostname",
    label: "Hostname",
    kind: "text",
    default: (a) => (isBackup(a) ? "schulos-backup" : "schulos"),
    validate: (v) => (isHostLabel(str(v)) ? null : "1–63 Zeichen: Buchstaben, Ziffern, Bindestrich"),
  },
  {
    id: "network.mode",
    label: "Netzwerk",
    kind: "select",
    options: () => [
      { value: "dhcp", label: "DHCP (automatisch)" },
      { value: "static", label: "Statisch" },
    ],
    default: () => "dhcp",
  },
  {
    id: "network.address",
    label: "IP-Adresse mit Präfix",
    help: "z. B. 192.168.10.5/24",
    kind: "text",
    when: isStatic,
    validate: (v) => {
      const r = parseCidr(str(v));
      return r.ok ? null : r.error;
    },
  },
  {
    id: "network.gateway",
    label: "Gateway",
    kind: "text",
    when: isStatic,
    validate: (v, a) => {
      const ip = parseIPv4(str(v));
      if (ip === null) return "IPv4-Adresse, z. B. 192.168.10.1";
      const net = parseCidr(str(a["network.address"] ?? ""));
      if (net.ok && !inSubnet(ip, net.cidr)) return "Das Gateway liegt nicht im Netz der IP-Adresse";
      if (net.ok && ip === net.cidr.ip) return "Gateway und eigene Adresse sind gleich";
      return null;
    },
  },
  {
    id: "network.dns",
    label: "DNS-Server",
    kind: "list",
    when: isStatic,
    validate: (v) => {
      const xs = list(v);
      if (!xs.length) return "Mindestens ein DNS-Server";
      const bad = xs.find((x) => parseIPv4(x) === null);
      return bad ? `„${bad}“ ist keine IPv4-Adresse` : null;
    },
  },
  {
    id: "network.proxy",
    label: "Proxy (optional)",
    help: "nur nötig, wenn das Schulnetz ins Internet nur über einen Proxy darf",
    kind: "text",
    optional: true,
    validate: (v) => checkProxyUrl(str(v)),
  },
  {
    // SEC-01/SEC-12: ein Begriff „Schulnetz“ für alles – App (2FA-Pflicht nur von außen, SCHULOS_INTERNAL_NETS), Caddy
    // (Außenzugang) und die Admin-Ebene (SSH nur von dort, nftables + sshd)
    id: "network.internal_nets",
    label: "Schulnetz-Bereiche",
    help: "Netze der Schule und des WireGuard-Zugangs (z. B. 10.10.0.0/16, 10.8.0.0/24) – nur von dort SSH; Anfragen von dort gelten als „im Schulnetz“. Vorgabe: private Adressbereiche",
    kind: "list",
    default: () => [...SSH_PRIVATE_NETS],
    validate: (v) => {
      const xs = list(v);
      if (!xs.length) return "Mindestens ein Netz";
      // G4E-O06: auch Host-Bits (10.10.0.5/24) sind ein Fehler – sshd nähme sonst niemanden an (Antwortdatei und --plan ebenso)
      for (const x of xs) {
        const c = checkNet(x);
        if (!c.ok) return c.error;
      }
      return null;
    },
    warn: (v) =>
      list(v).some((x) => x.trim() === "0.0.0.0/0" || x.trim() === "::/0")
        ? "Damit gilt das ganze Internet als Schulnetz – SSH wäre von überall erreichbar und Schutz für Zugriffe von außen entfiele (SEC-01/SEC-12)"
        : null,
  },
  {
    id: "access.password",
    label: "Passwort für das Wartungskonto schulos-admin",
    kind: "password",
    secret: true,
    notInEnv: true,
    validate: (v) => strongPassword(v, { username: "schulos-admin" }),
  },
  { id: "access.ssh", label: "SSH-Zugang", kind: "bool", default: () => false },
  {
    id: "access.console",
    label: "Hauptkonsole",
    help: "Bildschirm = Passphrase und Startmeldungen am Monitor · seriell = über die serielle Schnittstelle (Server ohne Bildschirm, IPMI/Serial-over-LAN)",
    kind: "select",
    options: () => [
      { value: "screen", label: "Bildschirm" },
      { value: "serial", label: "seriell (ttyS0)" },
    ],
    default: () => "screen",
  },
  {
    id: "access.ssh_keys",
    label: "SSH-Schlüssel (optional)",
    help: "öffentliche Schlüssel; mit Schlüssel ist die Anmeldung per Passwort aus",
    kind: "list",
    optional: true,
    when: (a) => a["access.ssh"] === true,
    validate: (v) => (list(v).every(isSshKey) ? null : "Öffentlicher Schlüssel wie „ssh-ed25519 AAAA… name“"),
  },
  {
    id: "updates.channel",
    label: "Update-Kanal",
    kind: "select",
    options: () => [
      { value: "stabil", label: "stabil" },
      { value: "beta", label: "beta (neue Funktionen früher)" },
    ],
    default: () => "stabil",
  },
  {
    id: "updates.window",
    label: "Wartungsfenster",
    help: "App-Updates und nötige Neustarts nur in diesem Zeitraum",
    kind: "text",
    default: () => "02:00-04:00",
    validate: (v) => {
      const r = parseWindow(str(v));
      return r.ok ? null : r.error;
    },
  },

  // §3.2 – Hauptsystem, Produktiv (die Demo bringt ihre Schule mit)
  { id: "school.name", label: "Name der Schule", kind: "text", when: isProduction, validate: (v) => (str(v).trim().length >= 3 ? null : "Mindestens 3 Zeichen") },
  {
    id: "school.state",
    label: "Bundesland",
    kind: "select",
    when: isProduction,
    options: () => STATES.map((s) => ({ value: s.code, label: s.code === "NW" ? s.name : `${s.name} (nicht freigegeben)` })),
    default: () => "NW",
    validate: (v) => (isStateCode(v) ? null : "Unbekanntes Bundesland"),
    warn: (v) =>
      v === "NW" ? null : "SchulOS ist bisher nur für Nordrhein-Westfalen freigegeben. Feiertage, Ferien und Schulformen sind für andere Länder nicht geprüft.",
  },
  {
    id: "school.number",
    label: "Schulnummer",
    kind: "text",
    when: isProduction,
    validate: (v, a) => {
      if (a["school.state"] === "NW") return /^\d{6}$/.test(str(v)) ? null : "Schulnummer in NRW: 6 Ziffern";
      return /^[0-9A-Za-z-]{3,12}$/.test(str(v)) ? null : "3–12 Zeichen";
    },
  },
  {
    id: "school.form",
    label: "Schulform",
    kind: "select",
    when: isProduction,
    options: (a) => formsForState((isStateCode(a["school.state"]) ? a["school.state"] : "NW") as StateCode).map((f) => ({ value: f.form, label: f.name })),
    default: () => "gesamtschule",
    validate: (v) => (isSchoolForm(v) ? null : "Unbekannte Schulform"),
  },
  {
    id: "school.templates",
    label: "Vorlagen übernehmen",
    help: "Fächer mit Fachfarben, Zeitraster, Jahrgänge, Stundentafel – keine Personendaten",
    kind: "bool",
    when: isProduction,
    default: () => false,
  },

  // Admin-Konto: Produktiv-Hauptsystem und Backupserver (2FA beim ersten Login)
  { id: "admin.first_name", label: "Admin: Vorname", kind: "text", when: hasAccounts, validate: (v) => (str(v).trim() ? null : "Pflicht") },
  { id: "admin.last_name", label: "Admin: Nachname", kind: "text", when: hasAccounts, validate: (v) => (str(v).trim() ? null : "Pflicht") },
  {
    id: "admin.username",
    label: "Admin: Benutzername",
    kind: "text",
    when: hasAccounts,
    validate: (v) => (/^[a-z0-9._]{3,30}$/.test(str(v)) ? null : "3–30 Zeichen a–z, 0–9, Punkt, Unterstrich"),
  },
  {
    id: "admin.password",
    label: "Admin: Passwort",
    help: "Die Zwei-Faktor-Anmeldung wird beim ersten Login eingerichtet",
    kind: "password",
    secret: true,
    notInEnv: true,
    when: hasAccounts,
    validate: (v, a) =>
      strongPassword(v, { username: str(a["admin.username"] ?? ""), firstName: str(a["admin.first_name"] ?? ""), lastName: str(a["admin.last_name"] ?? "") }),
  },

  // Adresse & TLS (beide Rollen)
  {
    id: "web.domain",
    label: "Adresse (Domain)",
    help: "unter diesem Namen erreichen Browser und Hauptsystem den Server, z. B. schulos.schule-xy.de",
    kind: "text",
    default: (a) => (isMain(a) && a.instance === "demo" ? "schulos.local" : undefined),
    validate: (v) => (isDomain(str(v)) ? null : "Domain wie schulos.schule-xy.de"),
  },
  {
    id: "web.tls",
    label: "Zertifikat",
    kind: "select",
    options: () => [
      { value: "internal", label: "nur Schulnetz (eigene CA)" },
      { value: "letsencrypt", label: "öffentliche Domain (Let's Encrypt)" },
      { value: "proxy", label: "hinter vorhandenem Proxy" },
    ],
    default: () => "internal",
    validate: (v, a) => (v === "letsencrypt" && !isPublicDomain(str(a["web.domain"] ?? "")) ? "Let's Encrypt braucht eine öffentliche Domain" : null),
  },
  {
    id: "web.acme_email",
    label: "E-Mail für Let's Encrypt",
    kind: "text",
    when: (a) => a["web.tls"] === "letsencrypt",
    validate: (v) => (isEmail(str(v)) ? null : "E-Mail-Adresse"),
  },
  // P4-40 Außenzugang (INSTALLATION.md „Außenzugang“) – nur Hauptsystem; Vorgabe: nur im Schulnetz
  {
    id: "web.trusted_proxies",
    label: "Adresse des Proxys (optional)",
    help: "IP-Adresse(n) des vorhandenen Proxys, z. B. 10.0.0.5 oder 10.0.0.0/29 – nur von dort zählt die weitergereichte Adresse der Besucher",
    kind: "list",
    optional: true,
    when: (a) => isMain(a) && a["web.tls"] === "proxy",
    validate: (v) => {
      const bad = list(v).find((x) => !isIpOrCidr(x));
      return bad ? `„${bad}“ ist keine IP-Adresse bzw. kein Netz wie 10.0.0.0/29` : null;
    },
  },
  {
    id: "web.public_access",
    label: "Aus dem Internet erreichbar",
    help: "Die Schulanmeldung für Eltern braucht „nur öffentliche Seiten“; alles Weitere bleibt im Schulnetz",
    kind: "select",
    when: isMain,
    options: () => [
      { value: "keiner", label: "nichts – nur im Schulnetz" },
      { value: "oeffentliche-seiten", label: "nur öffentliche Seiten (Schulanmeldung, Impressum, Datenschutz)" },
      { value: "alles", label: "ganz SchulOS (auch die Anmeldung mit Passwort)" },
    ],
    default: () => "keiner",
    // GATE-4c: hinter dem Proxy ohne dessen Adresse hätten alle Besucher dieselbe Adresse (Rate-Limits der Anmeldung für das
    // ganze Internet gemeinsam) und jede Anfrage gälte als Schulnetz – mit Außenzugang daher Pflicht
    validate: (v, a) =>
      v !== "keiner" && a["web.tls"] === "proxy" && list(a["web.trusted_proxies"] ?? []).length === 0
        ? "Mit Außenzugang hinter dem Proxy ist die Adresse des Proxys Pflicht (Frage „Adresse des Proxys“) – sonst gilt jede Anfrage als aus dem Schulnetz"
        : null,
    warn: (v, a) => {
      const hints: string[] = [];
      if (v === "keiner" && a["web.tls"] === "proxy" && list(a["web.trusted_proxies"] ?? []).length === 0)
        hints.push("Ohne Adresse des Proxys gilt jede Anfrage als aus dem Schulnetz – was von außen erreichbar ist, entscheidet dann allein der Proxy");
      if (v === "alles") hints.push("Auch Anmeldung und Verwaltung sind aus dem Internet erreichbar – nur mit Zwei-Faktor-Anmeldung für alle Konten und nach Rücksprache mit dem Datenschutz");
      if (v !== "keiner" && a["web.tls"] === "internal") hints.push("Mit der eigenen CA sehen Eltern eine Zertifikatswarnung – für den Außenzugang Let's Encrypt oder einen Proxy mit öffentlichem Zertifikat");
      return hints.length ? hints.join(" · ") : null;
    },
  },

  // §3.2/§3.3 – E-Mail (optional): Passwort-Reset, Benachrichtigungen, Alarme
  { id: "mail.host", label: "SMTP-Server (optional)", kind: "text", optional: true, when: hasMail, validate: (v) => (isDomain(str(v)) || parseIPv4(str(v)) !== null ? null : "Servername wie smtp.schule.de") },
  { id: "mail.port", label: "SMTP-Port", help: "587 = STARTTLS · 465 = TLS", kind: "number", when: mailOn, default: () => 587, validate: port },
  { id: "mail.user", label: "SMTP-Benutzer (optional)", kind: "text", optional: true, when: mailOn },
  { id: "mail.password", label: "SMTP-Passwort", kind: "password", secret: true, when: (a) => mailOn(a) && str(a["mail.user"] ?? "") !== "" },
  { id: "mail.from", label: "Absender", help: "z. B. SchulOS <schulos@schule.de>", kind: "text", when: mailOn, validate: (v) => (isSender(str(v)) ? null : "Absenderadresse, z. B. schulos@schule.de") },
  {
    id: "mail.alarm_to",
    label: "Empfänger für Alarme",
    help: "z. B. Backup überfällig, Platz knapp, Update fehlgeschlagen",
    kind: "list",
    when: mailOn,
    validate: (v) => {
      const xs = list(v);
      if (!xs.length) return "Mindestens eine Adresse";
      const bad = xs.find((x) => !isEmail(x));
      return bad ? `„${bad}“ ist keine E-Mail-Adresse` : null;
    },
  },

  // §3.2 – Backup des Hauptsystems
  {
    id: "backup.mode",
    label: "Backup",
    help: "Ohne Kopplung zeigt die Verwaltung dauerhaft eine rote Warnung",
    kind: "select",
    when: isFresh,
    options: () => [
      { value: "pair", label: "jetzt mit dem Backupserver koppeln" },
      { value: "later", label: "später koppeln" },
    ],
    default: (a) => (a.instance === "demo" ? "later" : "pair"),
    warn: (v, a) => (v === "later" && a.instance === "production" ? "Ohne Backup gehen bei einem Plattendefekt alle Daten verloren" : null),
  },
  { id: "backup.url", label: "Adresse des Backupservers", kind: "text", when: pairNow, validate: (v) => checkHttpsUrl(str(v)) },
  {
    id: "backup.code",
    label: "Kopplungscode",
    help: "steht am Ende der Installation des Backupservers bzw. in dessen Web-UI, z. B. K7Q2-9MXA-4RT1 · Wiederherstellen: Ersatz-Kopplungscode der Instanz",
    kind: "text",
    secret: true,
    when: pairNow,
    validate: (v) => (normalizePairingCode(str(v)) ? null : "12 Zeichen, z. B. K7Q2-9MXA-4RT1"),
  },

  // §3.3 – Backupserver
  ...(["daily", "weekly", "monthly"] as const).map(
    (k): Question => ({
      id: `retention.${k}`,
      label: { daily: "Aufbewahrung: tägliche Stände", weekly: "Aufbewahrung: wöchentliche Stände", monthly: "Aufbewahrung: monatliche Stände" }[k],
      kind: "number",
      when: isBackup,
      default: () => ({ daily: 14, weekly: 4, monthly: 3 })[k],
      validate: (v) => (Number.isInteger(v) && (v as number) >= LIMITS[k][0] && (v as number) <= LIMITS[k][1] ? null : `${LIMITS[k][0]} bis ${LIMITS[k][1]}`),
    }),
  ),
  {
    id: "retention.reason",
    label: "Begründung für die längere Aufbewahrung",
    help: "Gelöschte Daten bleiben so lange in den Sicherungen (Löschkonzept, DATENSCHUTZ.md §3.3)",
    kind: "text",
    when: (a) => isBackup(a) && preview(retentionOf(a)).needsReason,
    validate: (v) => (str(v).trim().length >= 10 ? null : "Mindestens 10 Zeichen"),
  },
  {
    id: "offsite.type",
    label: "Offsite-Kopie",
    help: "Backupserver: zusätzliche Kopie außer Haus, geht auch später in der Web-UI · Wiederherstellen: wo die Kopie liegt",
    kind: "select",
    when: hasOffsite,
    options: (a) => [
      ...(isBackup(a) ? [{ value: "off", label: "aus" }] : []),
      { value: "sftp", label: "SFTP (z. B. Hetzner Storage Box)" },
      { value: "s3", label: "S3" },
    ],
    default: (a) => (isBackup(a) ? "off" : undefined),
  },
  { id: "offsite.host", label: "SFTP-Server", kind: "text", when: offsite("sftp"), validate: (v) => (isDomain(str(v)) || parseIPv4(str(v)) !== null ? null : "Servername") },
  { id: "offsite.port", label: "SFTP-Port", help: "Hetzner Storage Box: 23", kind: "number", when: offsite("sftp"), default: () => 22, validate: port },
  { id: "offsite.user", label: "SFTP-Benutzer", kind: "text", when: offsite("sftp"), validate: (v) => (str(v).trim() ? null : "Pflicht") },
  { id: "offsite.password", label: "SFTP-Passwort", kind: "password", secret: true,
    notInEnv: true, when: offsite("sftp"), validate: (v) => (str(v) ? null : "Pflicht") },
  { id: "offsite.endpoint", label: "S3-Endpunkt", kind: "text", when: offsite("s3"), validate: (v) => checkHttpsUrl(str(v)) },
  { id: "offsite.access_key", label: "S3-Zugangsschlüssel (Access Key ID)", kind: "text", when: offsite("s3"), validate: (v) => (str(v).trim() ? null : "Pflicht") },
  { id: "offsite.secret_key", label: "S3-Geheimschlüssel", kind: "password", secret: true, when: offsite("s3"), validate: (v) => (str(v) ? null : "Pflicht") },
  {
    id: "offsite.path",
    label: "Ziel (Bucket/Pfad)",
    help: "SFTP: Ordner auf dem Server · S3: bucket/ordner · Wiederherstellen: dieser Ordner oder der Unterordner der Schule (i-…)",
    kind: "text",
    when: offsiteOn,
    default: (a) => (a["offsite.type"] === "sftp" ? "schulos" : undefined),
    validate: (v) => (/^[A-Za-z0-9._\-/]+$/.test(str(v)) && !str(v).includes("..") ? null : "Buchstaben, Ziffern, . _ - /"),
  },
  {
    id: "restore.recovery_key",
    label: "Wiederherstellungsschlüssel",
    help: "der bei der ersten Kopplung ausgedruckte Schlüssel, z. B. K7Q2M-9MXA4-RT1BC-…",
    kind: "text",
    secret: true,
    when: isRestoreOffsite,
    validate: (v) => (/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/.test(str(v).toUpperCase().replace(/\s+/g, "")) ? null : "30 Zeichen in 6 Gruppen, z. B. AB12C-…"),
  },
];

export function retentionOf(a: Answers): { daily: number; weekly: number; monthly: number } {
  const n = (k: string, d: number) => (typeof a[k] === "number" ? (a[k] as number) : d);
  return { daily: n("retention.daily", 14), weekly: n("retention.weekly", 4), monthly: n("retention.monthly", 3) };
}

export const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
