// Konfiguration je Rolle aus den Antworten erzeugen (INSTALLATION.md §3, §8.1): Compose-Variablen (.env), App-Konfiguration
// (schulos.env bzw. backup.env), Wartungsfenster als systemd-Drop-in und die Antworten ohne Passwörter. Rein bis auf den
// Zufall – Schreiben, Partitionieren und Starten übernehmen die Systemschritte (B-42).
import { randomBytes } from "node:crypto";
import { generateGrubPassword } from "@schulos/server/boot-hardening";
import { generatePairingCode, normalizePairingCode } from "@schulos/server/pairing";
import { applies, resolve, writeInstallYaml } from "./answers";
import { envSafe, hhmm, parseWindow } from "./checks";
import { QUESTIONS, retentionOf, SSH_PRIVATE_NETS, type Answers, type InstallContext } from "./questions";
import { rcloneObscure } from "./rclone";

export const MAIN_DIR = "/opt/schulos";
export const BACKUP_DIR = "/opt/schulos-backup";
export const ETC_DIR = "/etc/schulos";
export const WARTUNG_DROPIN = "/etc/systemd/system/schulos-wartung.timer.d/fenster.conf";
/** Bekannte Host-Schlüssel des SFTP-Offsite-Ziels; B-42 legt sie per ssh-keyscan an (Fingerabdruck in der Zusammenfassung) */
export const OFFSITE_KNOWN_HOSTS = "/srv/schulos-backup/config/offsite_known_hosts";
/** dasselbe im Agent-Container beim Wiederherstellen aus der Offsite-Kopie (nur für diesen einen Lauf eingebunden) */
export const RESTORE_KNOWN_HOSTS = "/run/offsite_known_hosts";

export interface PlanFile {
  path: string;
  content: string;
  mode: number;
}

export interface InstallPlan {
  role: "main" | "backup";
  /** Installationsordner des Compose-Stacks (schulosctl --dir) */
  stackDir: string;
  /** Compose-Datei der Rolle aus dem Repo bzw. der ISO (/opt/schulos-dist), im Stack als compose.yaml */
  composeSource: "compose.yaml" | "compose.backup.yaml";
  files: PlanFile[];
  /** Hauptsystem: nach dem ersten Start koppeln (der Code landet in keiner Datei) */
  pairing?: { url: string; code: string };
  /** Backupserver: Kopplungscode, den das Ende der Installation für das Hauptsystem anzeigt (24 h gültig) */
  pairingCode?: string;
  /**
   * Hauptsystem wiederherstellen (§4.4) – beim ersten Start, bevor die App läuft: „backup“ = Ersatz-Kopplung (pairing) und
   * neuesten Stand holen · „offsite“ = direkt aus der Offsite-Kopie (rclone-Ziel + Wiederherstellungsschlüssel), danach ungekoppelt
   */
  restore?: { mode: "backup" } | { mode: "offsite"; env: Record<string, string>; recoveryKey: string };
  /** Backupserver mit SFTP-Offsite: Host-Schlüssel holen und bestätigen lassen */
  offsiteHost?: { host: string; port: number };
  /** Angaben für die Systemschritte (B-42): Sprache, Platten, Verschlüsselung, Netz, Wartungskonto, Updates – mit Passphrase/Passwort */
  system: Answers;
}

const SYSTEM_PREFIXES = ["locale.", "disk.", "network.", "access.", "updates."];

/** Teil der Antworten, den die Systemschritte brauchen (keine App-Konten, keine SMTP-/Offsite-Zugänge – die stehen in den env-Dateien). */
export function systemAnswers(a: Answers): Answers {
  return Object.fromEntries(Object.entries(a).filter(([k]) => k === "role" || SYSTEM_PREFIXES.some((p) => k.startsWith(p))));
}

export interface GenerateDeps {
  /** scrypt-Hash wie Better-Auth (`better-auth/crypto` hashPassword) – das Klartext-Passwort landet nie in einer Datei */
  hashPassword(password: string): Promise<string>;
  randomSecret?: () => string;
  pairingCode?: () => string;
  /** G4E-O04/O05 (Q-4E-61): Bootmenü-Passwort (GRUB) – eigenes, zufälliges statt des Wartungspassworts */
  grubPassword?: () => string;
  now?: Date;
}

/** Schlüssel des Bootmenü-Passworts in `plan.system` (nur im Plan, nie in einer Datei des Zielsystems außer als Hash) */
export const GRUB_PASSWORD_KEY = "access.grub_password";

/** Zeichen, die in Compose-env_file und parseEnvFile ohne Anführungszeichen gleich gelesen werden */
const PLAIN = /^[A-Za-z0-9_.,:/@+=%-]*$/;

/** KEY=VALUE; Sonderzeichen in einfachen Anführungszeichen (Compose: wörtlich, ohne ${…}-Ersetzung), mit Apostroph in doppelten. */
export function envLine(key: string, value: string): string {
  if (PLAIN.test(value)) return `${key}=${value}`;
  if (!envSafe(value)) throw new Error(`${key}: Wert lässt sich nicht sicher in die Konfiguration schreiben`);
  return value.includes("'") ? `${key}="${value}"` : `${key}='${value}'`;
}

type Entry = [string, string | undefined] | string;

/** Kommentarzeilen (string) und Einträge; leere Werte fallen weg. */
export function envFile(entries: Entry[]): string {
  const lines = entries.flatMap((e) => (typeof e === "string" ? [`# ${e}`] : e[1] === undefined || e[1] === "" ? [] : [envLine(e[0], e[1])]));
  return lines.join("\n") + "\n";
}

const s = (a: Answers, id: string) => (typeof a[id] === "string" ? (a[id] as string) : undefined);
const n = (a: Answers, id: string) => (typeof a[id] === "number" ? String(a[id]) : undefined);
const xs = (a: Answers, id: string) => (Array.isArray(a[id]) ? (a[id] as string[]) : []);

function tls(a: Answers): Entry[] {
  if (a["web.tls"] === "letsencrypt") return [["SCHULOS_TLS", s(a, "web.acme_email")]];
  if (a["web.tls"] === "proxy") return ["hinter vorhandenem Proxy: der Proxy spricht https mit der eigenen CA dieses Servers", ["SCHULOS_TLS", "internal"]];
  return [["SCHULOS_TLS", "internal"]];
}

/** Außenzugang (P4-40) für die Caddy-Konfiguration in compose.yaml – immer ausdrücklich, auch die Vorgabe „keiner“. */
function publicAccess(a: Answers): Entry[] {
  const proxies = xs(a, "web.trusted_proxies");
  return [
    "Außenzugang (INSTALLATION.md „Außenzugang“): keiner = nur Schulnetz · oeffentliche-seiten = nur Schulanmeldung/Impressum/Datenschutz · alles",
    ["SCHULOS_PUBLIC_ACCESS", s(a, "web.public_access") ?? "keiner"],
    ...(proxies.length ? ["Proxy des Schulträgers: nur dessen X-Forwarded-For zählt" as Entry, ["SCHULOS_TRUSTED_PROXIES", proxies.join(" ")] as Entry] : []),
    ...internalNets(a),
  ];
}

/** SEC-01/SEC-12: Schulnetz für Caddy und App – nur, wenn es von der Vorgabe (private Bereiche = Caddys private_ranges) abweicht */
function internalNets(a: Answers): Entry[] {
  const nets = xs(a, "network.internal_nets").map((x) => x.trim()).filter(Boolean);
  const isDefault = !nets.length || (nets.length === SSH_PRIVATE_NETS.length && SSH_PRIVATE_NETS.every((n) => nets.includes(n)));
  return isDefault ? [] : ["Schulnetz (Installer-Frage „Schulnetz-Bereiche“): Caddy, App und SSH", ["SCHULOS_INTERNAL_NETS", nets.join(" ")]];
}

async function admin(a: Answers, deps: GenerateDeps): Promise<Entry[]> {
  return [
    "Admin-Konto beim ersten Start – Zwei-Faktor-Anmeldung beim ersten Login",
    ["SCHULOS_ADMIN_USERNAME", s(a, "admin.username")],
    ["SCHULOS_ADMIN_FIRST_NAME", s(a, "admin.first_name")],
    ["SCHULOS_ADMIN_LAST_NAME", s(a, "admin.last_name")],
    ["SCHULOS_ADMIN_PASSWORD_HASH", await deps.hashPassword(s(a, "admin.password")!)],
  ];
}

function mail(a: Answers): Entry[] {
  if (!s(a, "mail.host")) return [];
  return [
    "E-Mail: Testmail, Passwort-Reset, Alarme",
    ["SCHULOS_SMTP_HOST", s(a, "mail.host")],
    ["SCHULOS_SMTP_PORT", n(a, "mail.port")],
    ["SCHULOS_SMTP_USER", s(a, "mail.user")],
    ["SCHULOS_SMTP_PASSWORD", s(a, "mail.password")],
    ["SCHULOS_SMTP_FROM", s(a, "mail.from")],
    ["SCHULOS_ALARM_TO", xs(a, "mail.alarm_to").join(",")],
  ];
}

/** Proxy für ausgehende Verbindungen der App (Ferien-Abruf, Updates) – Node 24 liest HTTP(S)_PROXY mit NODE_USE_ENV_PROXY. */
function proxy(a: Answers, internal: string[]): Entry[] {
  const p = s(a, "network.proxy");
  if (!p) return [];
  return [
    "Proxy für Verbindungen ins Internet; Dienste im Schulnetz direkt",
    ["HTTPS_PROXY", p],
    ["HTTP_PROXY", p],
    ["NO_PROXY", ["localhost", "127.0.0.1", ...internal].join(",")],
    ["NODE_USE_ENV_PROXY", "1"],
  ];
}

/** systemd-Drop-in: der Wartungs-Timer startet im ersten Viertel des Fensters (Vorgabe 02:00–04:00 → 02:30 + bis zu 30 min). */
export function wartungDropin(window: string): string {
  const w = parseWindow(window);
  if (!w.ok) throw new Error(w.error);
  const quarter = Math.min(30, Math.floor(w.minutes / 4));
  return [
    `# Wartungsfenster ${hhmm(w.start)}–${hhmm(w.end)} (Installer, INSTALLATION.md §5a)`,
    "[Unit]",
    `Description=SchulOS: Wartungsfenster täglich ${hhmm(w.start)}–${hhmm(w.end)}`,
    "",
    "[Timer]",
    "OnCalendar=",
    `OnCalendar=*-*-* ${hhmm(w.start + quarter)}:00`,
    `RandomizedDelaySec=${quarter}min`,
    "",
  ].join("\n");
}

function offsite(a: Answers): Entry[] {
  const type = s(a, "offsite.type");
  if (type !== "sftp" && type !== "s3") return [];
  const common: Entry[] = ["Offsite-Kopie (täglich, gleiche Aufbewahrung, mit dem Wiederherstellungsschlüssel lesbar)", ["SCHULOS_OFFSITE", `offsite:${s(a, "offsite.path")}`]];
  if (type === "sftp")
    return [
      ...common,
      ["RCLONE_CONFIG_OFFSITE_TYPE", "sftp"],
      ["RCLONE_CONFIG_OFFSITE_HOST", s(a, "offsite.host")],
      ["RCLONE_CONFIG_OFFSITE_PORT", n(a, "offsite.port")],
      ["RCLONE_CONFIG_OFFSITE_USER", s(a, "offsite.user")],
      ["RCLONE_CONFIG_OFFSITE_PASS", rcloneObscure(s(a, "offsite.password")!)],
      ["RCLONE_CONFIG_OFFSITE_KNOWN_HOSTS_FILE", OFFSITE_KNOWN_HOSTS],
      ["RCLONE_CONFIG_OFFSITE_SHELL_TYPE", "none"],
    ];
  return [
    ...common,
    ["RCLONE_CONFIG_OFFSITE_TYPE", "s3"],
    ["RCLONE_CONFIG_OFFSITE_PROVIDER", "Other"],
    ["RCLONE_CONFIG_OFFSITE_ENDPOINT", s(a, "offsite.endpoint")],
    ["RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID", s(a, "offsite.access_key")],
    ["RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY", s(a, "offsite.secret_key")],
  ];
}

/** Antworten → Dateien. Unvollständige oder ungültige Antworten sind ein Programmfehler (vorher resolve() bzw. die TUI). */
export async function generate(input: Answers, deps: GenerateDeps, ctx: InstallContext = {}): Promise<InstallPlan> {
  const r = resolve(input, ctx);
  if (!r.complete) throw new Error(`Angaben unvollständig: ${[...r.missing, ...r.errors.map((e) => `${e.id} (${e.message})`)].join(", ")}`);
  const a = r.answers;
  const secret = deps.randomSecret ?? (() => randomBytes(24).toString("hex"));
  const stamp = `Erzeugt vom SchulOS-Installer am ${(deps.now ?? new Date()).toISOString().slice(0, 10)} – Änderungen später über die Verwaltung bzw. schulosctl`;
  const exported = { path: `${ETC_DIR}/schulos-install.yaml`, content: writeInstallYaml(a), mode: 0o600 };
  const system = { ...systemAnswers(a), [GRUB_PASSWORD_KEY]: (deps.grubPassword ?? generateGrubPassword)() };

  if (a.role === "main") {
    const production = a.instance === "production";
    const restoring = a.instance === "restore-backup" || a.instance === "restore-offsite";
    const backupHost = s(a, "backup.url") ? new URL(s(a, "backup.url")!).hostname : undefined;
    const compose = envFile([
      stamp,
      "Variablen für compose.yaml – die App liest schulos.env",
      ["POSTGRES_PASSWORD", secret()],
      // SEC-07: Wartungsrolle „postgres“ (Superuser) – die App nutzt „schulos“ ohne Superuser-Recht
      ["POSTGRES_ADMIN_PASSWORD", secret()],
      ["SCHULOS_DOMAIN", s(a, "web.domain")],
      ...tls(a),
      ...publicAccess(a),
      ["SCHULOS_CHANNEL", s(a, "updates.channel")],
    ]);
    const app = envFile([
      stamp,
      `${
        restoring
          ? "Produktiv, aus einer Sicherung wiederhergestellt (Konten und Schule kommen aus der Sicherung)"
          : production
            ? "Produktiv: leer bis auf das Admin-Konto"
            : "Demo: Gesamtschule am Lindenhof, keine echten Daten"
      } – später nicht änderbar`,
      ["SCHULOS_INSTANCE", production || restoring ? "production" : "demo"],
      ...(production
        ? [
            ...(await admin(a, deps)),
            "Schule",
            ["SCHULOS_SCHOOL_NAME", s(a, "school.name")] as Entry,
            ["SCHULOS_SCHOOL_NUMBER", s(a, "school.number")] as Entry,
            ["SCHULOS_SCHOOL_STATE", s(a, "school.state")] as Entry,
            ["SCHULOS_SCHOOL_FORM", s(a, "school.form")] as Entry,
            ["SCHULOS_TEMPLATES", a["school.templates"] === true ? "1" : undefined] as Entry,
          ]
        : []),
      ...mail(a),
      ...proxy(a, ["postgres", "app", "caddy", s(a, "web.domain")!, ...(backupHost ? [backupHost] : [])]),
    ]);
    const code = s(a, "backup.code");
    return {
      role: "main",
      system,
      stackDir: MAIN_DIR,
      composeSource: "compose.yaml",
      files: [
        { path: `${MAIN_DIR}/.env`, content: compose, mode: 0o600 },
        { path: `${MAIN_DIR}/schulos.env`, content: app, mode: 0o600 },
        { path: WARTUNG_DROPIN, content: wartungDropin(s(a, "updates.window")!), mode: 0o644 },
        exported,
      ],
      ...((a["backup.mode"] === "pair" || a.instance === "restore-backup") && code
        ? { pairing: { url: s(a, "backup.url")!.replace(/\/+$/, ""), code: normalizePairingCode(code)!.replace(/(.{4})(?!$)/g, "$1-") } }
        : {}),
      ...(a.instance === "restore-backup" ? { restore: { mode: "backup" as const } } : {}),
      ...(a.instance === "restore-offsite"
        ? {
            restore: {
              mode: "offsite" as const,
              env: {
                ...Object.fromEntries(offsite(a).filter((e): e is [string, string] => typeof e !== "string" && e[1] !== undefined)),
                // der Erststart holt den Host-Schlüssel (ssh-keyscan) und bindet ihn hier in den Agent-Container ein
                ...(a["offsite.type"] === "sftp" ? { RCLONE_CONFIG_OFFSITE_KNOWN_HOSTS_FILE: RESTORE_KNOWN_HOSTS } : {}),
              },
              recoveryKey: s(a, "restore.recovery_key")!.toUpperCase().replace(/\s+/g, ""),
            },
          }
        : {}),
    };
  }

  const pairingCode = (deps.pairingCode ?? generatePairingCode)();
  const ret = retentionOf(a);
  const compose = envFile([
    stamp,
    "Variablen für compose.backup.yaml (im Stack: compose.yaml) – die App liest backup.env",
    ["SCHULOS_BACKUP_DOMAIN", s(a, "web.domain")],
    ...tls(a),
    ["RESTORE_TEST_DB_PASSWORD", secret()],
  ]);
  const app = envFile([
    stamp,
    ...(await admin(a, deps)),
    "Kopplungscode für das Hauptsystem – wird beim ersten Start übernommen, 24 h gültig, einmal verwendbar",
    ["SCHULOS_INITIAL_PAIRING_CODE", pairingCode],
    "Aufbewahrung neuer Instanzen: täglich/wöchentlich/monatlich",
    ["SCHULOS_RETENTION", `${ret.daily}/${ret.weekly}/${ret.monthly}`],
    ["SCHULOS_RETENTION_REASON", s(a, "retention.reason")],
    ...offsite(a),
    ...mail(a),
    ...proxy(a, ["backup", "rest-server", "caddy", s(a, "web.domain")!]),
  ]);
  return {
    role: "backup",
    system,
    stackDir: BACKUP_DIR,
    composeSource: "compose.backup.yaml",
    files: [
      { path: `${BACKUP_DIR}/.env`, content: compose, mode: 0o600 },
      { path: `${BACKUP_DIR}/backup.env`, content: app, mode: 0o600 },
      exported,
    ],
    pairingCode,
    ...(a["offsite.type"] === "sftp" ? { offsiteHost: { host: s(a, "offsite.host")!, port: a["offsite.port"] as number } } : {}),
  };
}

export interface SummaryLine {
  id: string;
  label: string;
  value: string;
}

/** Zusammenfassung vor „Installieren“ (§1 Schritt 2): Klartext je Frage, Geheimnisse verdeckt. */
export function summarize(input: Answers, ctx: InstallContext = {}): SummaryLine[] {
  const { answers } = resolve(input, ctx);
  const out: SummaryLine[] = [];
  for (const q of QUESTIONS) {
    const v = answers[q.id];
    if (v === undefined || !applies(q, answers, ctx)) continue;
    let value: string;
    if (q.secret) value = "••••••••";
    else if (typeof v === "boolean") value = v ? "ja" : "nein";
    else if (Array.isArray(v)) value = (q.options ? v.map((x) => q.options!(answers, ctx).find((o) => o.value === x)?.label ?? x) : v).join(", ");
    else value = q.kind === "select" ? (q.options?.(answers, ctx).find((o) => o.value === v)?.label ?? String(v)) : String(v);
    out.push({ id: q.id, label: q.label, value });
  }
  return out;
}
