// Reine Logik von schulosctl (B-31): Aufruf zerlegen, Status auswerten, Support-Bundle ohne Personendaten.
import { backupHealth, HEALTH_LABEL, type AgentState } from "@schulos/server/agent-api";

export const USAGE = `schulosctl – Betrieb von SchulOS (INSTALLATION.md §5)

Aufruf: schulosctl [--dir <installationsordner>] <befehl>

  status                  Dienste, Version, Instanz, Backup, Speicherplatz
  backup now              jetzt sichern (Backup-Agent, wartet auf das Ergebnis)
  reset-admin [name]      Admin-Zugang wiederherstellen: neues Passwort, zweiter Faktor aus, Sperre weg
  schulnetz-zuruecksetzen Schulnetz-Bereiche der Anmeldung (Verwaltung → System) auf die Vorgabe zurück – wer sich
                          mit einer falschen Liste ausgesperrt hat (Q-4E-42)
  demo-reset [--yes]      Demo-Instanz zurücksetzen (nur Demo; App kurz gestoppt)
  update [--check] [--yes] [--kanal stabil|beta] [--quelle <ordner>] [--ohne-backup]
                          auf die nächste Version im Kanal: Signatur prüfen, Backup, Probelauf auf einer
                          Kopie, Update, Healthcheck, bei Fehler zurück (Minor/Major nur mit Freigabe)
  db-rolle                App-Datenbankrolle ohne Superuser prüfen bzw. einmalig umstellen (SEC-07; macht update
                          auch selbst): Wartungsrolle „postgres“, POSTGRES_ADMIN_PASSWORD in .env
  test-restore            neuesten Stand vom Backupserver in eine Wegwerf-Datenbank, App darauf starten,
                          Rauchtest, danach alles löschen (Ergänzung zur monatlichen Prüfung)
  system-sync             Abgleich mit Verwaltung → System (systemd-Timer): Auftrag ausführen, Status schreiben
  wartungsfenster         im Wartungsfenster (systemd-Timer): Patches automatisch, Funktions-Updates nur freigegeben;
                          braucht Debian einen Neustart (Kernel, libc), danach sichern und neu starten –
                          nur mit TPM2; bei LUKS-Passphrase nur melden (Verwaltung → System, Alarm-Mail)
  os-upgrade [--ziel <codename>] [--yes]
                          Debian-Versionswechsel (z. B. 13 „trixie“ → 14 „forky“): Sicherung + Test-Restore,
                          Schnappschuss, Umstellung, Neustart; nach dem Start geprüft, sonst automatisch zurück
  os-upgrade-pruefen      (systemd nach dem Start) Versionswechsel abschließen oder zurücknehmen
  os-rollback [--yes]     zurück auf den Schnappschuss vor dem letzten Versionswechsel (von Hand), Neustart
  vorschau an [--domain <adresse>] [--extern] | aus | aktualisieren | reset | nacht | profil [--aus]
                          Vorschau-Instanz: nächste Version mit Demo-Daten unter eigener Subdomain – nur im Schulnetz;
                          --extern: auch aus dem Internet (Demo-Konten mit bekanntem Passwort!)
                          profil: Schulprofil des Hauptsystems (Logo, Module, Rechte, Einstellungen – ohne Personen)
                          in die Vorschau übernehmen und zurücksetzen; --aus: wieder reine Demo-Schule (P4-77)
  bundle create <version…> [--out <datei>] [--quelle <ordner>]
                          Offline-Bundle (Releases + Images) auf einem Rechner mit Internet erstellen
  bundle import <datei>   Offline-Bundle auf dem Server einspielen (Signaturen und Digests geprüft)
  support-bundle [--out <datei>]
                          Diagnosepaket (.tar.gz) ohne Personendaten: Status, Versionen, Logs geschwärzt
  wiederherstellungsschluessel [--yes]
                          neuer Wiederherstellungsschlüssel der Platte (TPM2, nur root an der Konsole): per TPM
                          entsperrt, neuen anzeigen und bestätigen lassen, danach den alten löschen
  sicherheit-nachruesten [--yes] [--passwort-stdin]
                          (SEC-09, root an der Konsole) neues Bootmenü-Passwort (GRUB) erzeugen und anzeigen
                          (--passwort-stdin: eigenes von stdin, nur a–x, A–X, 0–9) und bei TPM2 die Bindung an
                          PCR 7+8+9 vorbereiten bzw. – schon gebunden – den Übergang anlegen; auch auf dem Backupserver
                          (kopierte schulosctl.mjs: sudo node schulosctl.mjs sicherheit-nachruesten)
  tpm-neu-binden          (root an der Konsole) Platte von Hand an PCR 7+8+9 binden – nach einem Start mit dem
                          Wiederherstellungsschlüssel (fragt ihn ab), Secure Boot an, ohne Startmedium
  ssh-netze [<netz>…] [--yes]
                          SSH nur aus diesen Netzen (Firewall + sshd, SEC-12); ohne Netze: anzeigen. Nach einer
                          Änderung der Schulnetz-Bereiche in Verwaltung → System hier nachziehen (G4E-O17)
  version                 Version von schulosctl

Installationsordner: --dir, sonst SCHULOS_DIR, sonst /opt/schulos (dort liegen compose.yaml und .env).`;

export type Command =
  | { name: "status" }
  | { name: "backup-now" }
  | { name: "reset-admin"; username?: string }
  | { name: "schulnetz-zuruecksetzen" }
  | { name: "demo-reset"; yes: boolean }
  | { name: "support-bundle"; out?: string }
  | { name: "update"; check: boolean; yes: boolean; channel?: "stabil" | "beta"; source?: string; skipBackup: boolean }
  | { name: "test-restore" }
  | { name: "db-rolle" }
  | { name: "system-sync" }
  | { name: "wartungsfenster" }
  | { name: "os-upgrade"; target?: string; yes: boolean }
  | { name: "os-upgrade-pruefen" }
  | { name: "os-rollback"; yes: boolean }
  | { name: "bundle"; action: "create"; versions: string[]; out?: string; source?: string }
  | { name: "bundle"; action: "import"; file?: string }
  | { name: "vorschau"; action: "an" | "aus" | "aktualisieren" | "reset" | "nacht" | "profil"; domain?: string; extern?: boolean; off?: boolean }
  | { name: "wiederherstellungsschluessel"; yes: boolean }
  | { name: "sicherheit-nachruesten"; yes: boolean; passwordStdin: boolean }
  | { name: "tpm-neu-binden" }
  | { name: "ssh-netze"; nets: string[]; yes: boolean }
  | { name: "version" }
  | { name: "help" };

export interface Invocation {
  dir: string;
  command: Command;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Invocation {
  const args = [...argv];
  let dir = env.SCHULOS_DIR || "/opt/schulos";
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new UsageError(`${flag} braucht einen Wert`);
    args.splice(i, 2);
    return v;
  };
  const flag = (f: string): boolean => {
    const i = args.indexOf(f);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  dir = take("--dir") ?? dir;
  const out = take("--out");
  const kanal = take("--kanal");
  const domain = take("--domain");
  const quelle = take("--quelle");
  const ziel = take("--ziel");
  const yes = flag("--yes");
  const check = flag("--check");
  const skipBackup = flag("--ohne-backup");
  const extern = flag("--extern");
  const off = flag("--aus");
  const passwordStdin = flag("--passwort-stdin");
  if (kanal && kanal !== "stabil" && kanal !== "beta") throw new UsageError("--kanal: stabil oder beta");
  if (flag("--help") || flag("-h")) return { dir, command: { name: "help" } };
  const [a, b, ...rest] = args;
  const extra = (n: number) => {
    if (args.length > n) throw new UsageError(`Unerwartet: ${args.slice(n).join(" ")}`);
  };
  switch (a) {
    case undefined:
    case "help":
      return { dir, command: { name: "help" } };
    case "status":
      extra(1);
      return { dir, command: { name: "status" } };
    case "version":
      extra(1);
      return { dir, command: { name: "version" } };
    case "backup":
      if (b !== "now") throw new UsageError("Meinten Sie: schulosctl backup now");
      extra(2);
      return { dir, command: { name: "backup-now" } };
    case "reset-admin":
      if (rest.length) throw new UsageError(`Unerwartet: ${rest.join(" ")}`);
      return { dir, command: { name: "reset-admin", ...(b ? { username: b } : {}) } };
    case "schulnetz-zuruecksetzen":
      extra(1);
      return { dir, command: { name: "schulnetz-zuruecksetzen" } };
    case "demo-reset":
      extra(1);
      return { dir, command: { name: "demo-reset", yes } };
    case "update":
      extra(1);
      return {
        dir,
        command: {
          name: "update",
          check,
          yes,
          skipBackup,
          ...(kanal ? { channel: kanal as "stabil" | "beta" } : {}),
          ...(quelle ? { source: quelle } : {}),
        },
      };
    case "test-restore":
      extra(1);
      return { dir, command: { name: "test-restore" } };
    case "db-rolle":
      extra(1);
      return { dir, command: { name: "db-rolle" } };
    case "system-sync":
      extra(1);
      return { dir, command: { name: "system-sync" } };
    case "wartungsfenster":
      extra(1);
      return { dir, command: { name: "wartungsfenster" } };
    case "vorschau":
      if (b !== "an" && b !== "aus" && b !== "aktualisieren" && b !== "reset" && b !== "nacht" && b !== "profil")
        throw new UsageError("schulosctl vorschau an | aus | aktualisieren | reset | nacht | profil [--aus]");
      extra(2);
      if (extern && b !== "an") throw new UsageError("--extern nur mit „vorschau an“");
      if (off && b !== "profil") throw new UsageError("--aus nur mit „vorschau profil“");
      return { dir, command: { name: "vorschau", action: b, ...(domain ? { domain } : {}), ...(extern ? { extern } : {}), ...(off ? { off } : {}) } };
    case "bundle":
      if (b === "create") {
        if (!rest.length) throw new UsageError("schulosctl bundle create <version…>");
        return { dir, command: { name: "bundle", action: "create", versions: rest, ...(out ? { out } : {}), ...(quelle ? { source: quelle } : {}) } };
      }
      if (b === "import") {
        if (rest.length !== 1) throw new UsageError("schulosctl bundle import <datei>");
        return { dir, command: { name: "bundle", action: "import", file: rest[0] } };
      }
      throw new UsageError("schulosctl bundle create <version…> | bundle import <datei>");
    case "os-upgrade":
      extra(1);
      return { dir, command: { name: "os-upgrade", yes, ...(ziel ? { target: ziel } : {}) } };
    case "os-upgrade-pruefen":
      extra(1);
      return { dir, command: { name: "os-upgrade-pruefen" } };
    case "os-rollback":
      extra(1);
      return { dir, command: { name: "os-rollback", yes } };
    case "wiederherstellungsschluessel":
      extra(1);
      return { dir, command: { name: "wiederherstellungsschluessel", yes } };
    case "sicherheit-nachruesten":
      extra(1);
      return { dir, command: { name: "sicherheit-nachruesten", yes, passwordStdin } };
    case "tpm-neu-binden":
      extra(1);
      return { dir, command: { name: "tpm-neu-binden" } };
    case "ssh-netze":
      return { dir, command: { name: "ssh-netze", nets: args.slice(1), yes } };
    case "support-bundle":
      extra(1);
      return { dir, command: { name: "support-bundle", ...(out ? { out } : {}) } };
    default:
      throw new UsageError(`Unbekannter Befehl „${a}“ – schulosctl help`);
  }
}

export interface ServiceStatus {
  service: string;
  state: string;
  health: string;
}

/** `docker compose ps --all --format json`: je Zeile ein Objekt (neuere Compose-Versionen) oder ein Array (ältere). */
export function parseComposePs(output: string): ServiceStatus[] {
  const text = output.trim();
  if (!text) return [];
  const items: Record<string, unknown>[] = text.startsWith("[")
    ? (JSON.parse(text) as Record<string, unknown>[])
    : text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return items
    .map((i) => ({ service: String(i.Service ?? i.Name ?? "?"), state: String(i.State ?? "?"), health: String(i.Health ?? "") }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

export interface AppInfo {
  version: string;
  instance: string;
  database: string;
  migrations: number;
  accounts: Record<string, number>;
}

export interface StatusInput {
  services: ServiceStatus[];
  app: AppInfo | null;
  backup: AgentState | null;
  /** Speicherplatz des Installationsordners bzw. Docker-Speichers */
  disk: { usedPercent: number; freeBytes: number } | null;
  now: Date;
  /** Ergebnis von dockerExposureProblem (GATE-4c) */
  exposure?: string | null;
}

/**
 * GATE-4c (SICHERHEIT S35): Außenzugang offen, aber Docker mit Userland-Proxy – dann kommt IPv6 von außen mit der Adresse des
 * Bridge-Gateways an und gilt als Schulnetz. Bestandsinstallationen (vor dem Installer-Fix) brauchen den Nachtrag aus
 * INSTALLATION.md §5b Punkt 6. `daemonJson` = Inhalt von /etc/docker/daemon.json (null = fehlt).
 */
export function dockerExposureProblem(daemonJson: string | null, publicAccess: string | undefined): string | null {
  if (!publicAccess || publicAccess === "keiner") return null;
  let off = false;
  try {
    off = (JSON.parse(daemonJson ?? "{}") as Record<string, unknown>)["userland-proxy"] === false;
  } catch {
    off = false;
  }
  return off ? null : 'Außenzugang an, aber Docker mit Userland-Proxy (IPv6 gilt als Schulnetz) – "userland-proxy": false setzen (INSTALLATION §5b)';
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1).replace(".", ",")} ${units[i]}`;
}

const berlin = (iso: string) =>
  new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });

/** Gesamturteil + Zeilen für `schulosctl status`. Exitcode 0 = alles in Ordnung, 1 = Warnung/Fehler. */
export function formatStatus(s: StatusInput): { ok: boolean; lines: string[] } {
  const problems: string[] = [];
  const lines: string[] = [];
  if (s.app) {
    const total = Object.values(s.app.accounts).reduce((a, b) => a + b, 0);
    lines.push(`SchulOS ${s.app.version} · Instanz ${s.app.instance} · Datenbank ${s.app.database} (${s.app.migrations} Migrationen) · ${total} Konten`);
  } else {
    lines.push("SchulOS: App antwortet nicht");
    problems.push("App antwortet nicht");
  }
  lines.push("", "Dienste:");
  if (!s.services.length) problems.push("keine Dienste gefunden (läuft der Stack?)");
  for (const svc of s.services) {
    const bad = svc.state !== "running" || (svc.health !== "" && svc.health !== "healthy");
    if (bad) problems.push(`${svc.service}: ${svc.state}${svc.health ? `/${svc.health}` : ""}`);
    lines.push(`  ${bad ? "✗" : "✓"} ${svc.service.padEnd(16)} ${svc.state}${svc.health ? ` (${svc.health})` : ""}`);
  }
  lines.push("", "Backup:");
  if (!s.backup) {
    lines.push("  nicht gekoppelt (Verwaltung → Backup)");
    problems.push("Backup nicht eingerichtet");
  } else {
    const h = backupHealth(s.backup.lastOkAt ? new Date(s.backup.lastOkAt) : null, s.backup.lastRun, s.now);
    lines.push(`  ${h === "ok" ? "✓" : "✗"} ${HEALTH_LABEL[h]}${s.backup.lastOkAt ? ` – letzte Sicherung ${berlin(s.backup.lastOkAt)}` : ""}`);
    if (s.backup.runningSince) lines.push(`  läuft seit ${berlin(s.backup.runningSince)}`);
    if (s.backup.lastRun?.status === "failed" && s.backup.lastRun.error) lines.push(`  Fehler: ${s.backup.lastRun.error}`);
    if (s.backup.lastContactError) lines.push(`  Backupserver nicht erreichbar: ${s.backup.lastContactError}`);
    if (h !== "ok") problems.push(`Backup ${HEALTH_LABEL[h]}`);
  }
  if (s.disk) {
    const warn = s.disk.usedPercent >= 90;
    lines.push("", `Speicher: ${warn ? "✗" : "✓"} ${s.disk.usedPercent} % belegt, ${formatBytes(s.disk.freeBytes)} frei`);
    if (warn) problems.push("Speicherplatz knapp");
  }
  if (s.exposure) {
    lines.push("", `Außenzugang: ✗ ${s.exposure}`);
    problems.push("Außenzugang über IPv6 offen");
  }
  lines.unshift(problems.length ? `Zustand: ACHTUNG – ${problems.join("; ")}` : "Zustand: in Ordnung", "");
  return { ok: problems.length === 0, lines };
}

/** `df -P -B1 <pfad>` → belegt in %, frei in Bytes. */
export function parseDf(output: string): { usedPercent: number; freeBytes: number } | null {
  const line = output.trim().split(/\r?\n/)[1];
  const cols = line?.trim().split(/\s+/);
  if (!cols || cols.length < 5) return null;
  const free = Number(cols[3]);
  const pct = Number(cols[4]!.replace("%", ""));
  return Number.isFinite(free) && Number.isFinite(pct) ? { usedPercent: pct, freeBytes: free } : null;
}

// ---------- Support-Bundle: ohne Personendaten ----------

const SECRET_KEY = /(PASS|SECRET|TOKEN|KEY|DATABASE_URL|_URL$|CREDENTIAL|PRIVATE)/i;

/** KEY=VALUE-Dateien (.env, schulos.env): Werte geheimer Schlüssel und Admin-Angaben durch *** ersetzen. */
export function sanitizeEnv(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) return line;
      const [, pre, key] = m;
      const personal = /^SCHULOS_(ADMIN_|SCHOOL_NAME|SCHOOL_NUMBER)/.test(key!) || /DOMAIN|EMAIL|MAIL_FROM/.test(key!);
      return SECRET_KEY.test(key!) || personal ? `${pre}${key}=***` : line;
    })
    .join("\n");
}

/**
 * Logzeilen schwärzen: E-Mail-Adressen, IP-Adressen (außer Loopback/Docker-intern bleibt erkennbar als Klasse),
 * Bearer-/Basic-Token, lange Zufallszeichenketten (Token, Sitzungen), Benutzernamen in „…“ und Schlüssel=Wert-Paare
 * mit Personenbezug. Lieber zu viel als zu wenig – das Bundle verlässt die Schule.
 */
export function redactLog(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <token>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip.startsWith("127.") || ip === "0.0.0.0" ? ip : "<ip>"))
    // IPv6 (auch verkürzt mit ::) – Uhrzeiten wie 04:10:05 haben weder Buchstaben noch ::
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, (ip) =>
      ip === "::1" || !(ip.includes("::") || /[a-f]/i.test(ip)) ? ip : "<ip>",
    )
    .replace(/„[^“\n]{1,80}“/g, "„<name>“")
    .replace(/\b(user(?:name)?|benutzer|name|login|email|to|from|remote_ip|client_ip|cookie|token|password|passwort)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2<…>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (s) => (/^[0-9a-f]{64}$/.test(s) ? s : "<zufall>"));
}
