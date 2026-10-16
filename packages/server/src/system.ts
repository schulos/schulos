// Verwaltung → System (B-33, INSTALLATION.md §5a): Schnittstelle zwischen App und Host ohne Docker-Socket in der App.
// Beide Seiten tauschen Dateien im Konfigurationsordner (Volume `config`) aus:
//  - system-status.json  schreibt schulosctl (systemd-Timer `schulosctl system-sync`): Version, Kanal, verfügbare Updates,
//                        Protokoll, Betriebssystem – die App zeigt sie nur an
//  - system-auftrag.json schreibt die App (Admin gibt ein Update frei, wechselt den Kanal); schulosctl holt den Auftrag
//                        beim nächsten Lauf ab, führt ihn aus und löscht ihn
import type { Channel, ReleaseChange, UpdateKind } from "./release";

export const SYSTEM_STATUS_FILE = "system-status.json";
export const SYSTEM_ORDER_FILE = "system-auftrag.json";

/** Eintrag im Update-Protokoll (updates/protokoll.jsonl auf dem Host, die letzten in system-status.json). */
export interface ProtocolEntry {
  at: string;
  step: "plan" | "test-restore" | "backup" | "probelauf" | "loeschnachweis" | "dump" | "update" | "healthcheck" | "rueckweg" | "fertig" | "abbruch" | "auftrag" | "os-upgrade" | "os-rueckweg" | "os-aufraeumen" | "neustart" | "db-rolle" | "compose" | "schulosctl";
  ok: boolean;
  from?: string;
  to?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export const PROTOCOL_STEP_LABEL: Record<ProtocolEntry["step"], string> = {
  plan: "Update geplant",
  "test-restore": "Test-Restore mit App-Start",
  backup: "Sicherung vor dem Update",
  probelauf: "Probelauf auf einer Kopie",
  loeschnachweis: "Kopie gelöscht",
  dump: "Datenbankstand für den Rückweg",
  update: "Update eingespielt",
  healthcheck: "Healthcheck",
  rueckweg: "Rückweg",
  fertig: "Update fertig",
  abbruch: "Abgebrochen",
  auftrag: "Auftrag aus der Verwaltung",
  "os-upgrade": "Debian-Versionswechsel",
  "os-rueckweg": "Debian-Versionswechsel zurückgenommen",
  "os-aufraeumen": "Reste früherer Rückwege aufräumen",
  neustart: "Neustart im Wartungsfenster",
  "db-rolle": "Datenbankrolle ohne Superuser-Recht (einmalige Umstellung)",
  compose: "Compose-Datei aus dem Release übernommen",
  schulosctl: "schulosctl aus dem Release übernommen",
};

export interface AvailableRelease {
  version: string;
  publishedAt: string;
  securityRelevant: boolean;
  changes: ReleaseChange[];
}

export interface OsInfo {
  name: string;
  /** z. B. "13" */
  versionId: string;
  codename: string;
  /** Ende der regulären Sicherheitsupdates (ISO-Datum), sofern bekannt */
  securityUntil: string | null;
  /** Ende des Langzeit-Supports (Debian LTS), sofern bekannt */
  ltsUntil: string | null;
}

export interface SystemStatus {
  version: 1;
  checkedAt: string;
  current: string;
  channel: Channel;
  /** null = Releases nicht abrufbar (siehe error) */
  update:
    | { status: "aktuell" }
    | { status: "verfügbar"; kind: UpdateKind; securityRelevant: boolean; steps: AvailableRelease[] }
    | { status: "blockiert"; reason: string }
    | null;
  /** Freigabe, die auf das Wartungsfenster wartet */
  approved: { version: string; by: string; at: string } | null;
  /** neueste zuerst */
  protocol: ProtocolEntry[];
  os: OsInfo | null;
  /** Speicherplatz des Installationsordners auf dem Host (B-38: Alarm ab 90 %) */
  disk?: { usedPercent: number; freeBytes: number } | null;
  /**
   * Q5-18: Debian braucht einen Neustart, die Platte wird aber per Passphrase entsperrt – das Wartungsfenster startet dann
   * nicht selbst neu (der Server hinge nachts an der Passphrase). `since` = seit wann der Neustart aussteht.
   */
  reboot?: { since: string; reason: "passphrase" } | null;
  /**
   * G4E-O03: TPM2 ohne PIN – ist die Platte vollständig an PCR 7+8+9 gebunden? `problems` leer = in Ordnung; null bzw. fehlend =
   * kein TPM2 ohne PIN (Passphrase, PIN, unverschlüsselt) bzw. älteres schulosctl.
   */
  tpm?: { problems: string[] } | null;
  error?: string;
}

/** Q5-18: so viele Tage darf ein Neustart ausstehen, bevor die Verwaltung ihn rot anzeigt. */
export const REBOOT_RED_DAYS = 14;

/** Ganze Tage seit dem ersten Erkennen des ausstehenden Neustarts. */
export function rebootPendingDays(reboot: { since: string }, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(reboot.since)) / 86_400_000));
}

export type SystemOrder =
  | { version: 1; id: string; createdAt: string; by: string; action: "freigabe"; target: string; when: "jetzt" | "wartungsfenster" }
  | { version: 1; id: string; createdAt: string; by: string; action: "kanal"; channel: Channel }
  /** Q5-18: Neustart von Hand (nur wenn er aussteht; danach muss jemand die Passphrase an der Konsole eingeben) */
  | { version: 1; id: string; createdAt: string; by: string; action: "neustart" };

/** Prüft einen Auftrag (von der App geschrieben, vom Host gelesen – beide Seiten vertrauen nur geprüften Daten). */
export function parseOrder(raw: unknown): SystemOrder {
  if (!raw || typeof raw !== "object") throw new Error("Auftrag: kein Objekt");
  const o = raw as Record<string, unknown>;
  const base = typeof o.id === "string" && /^[\w-]{6,64}$/.test(o.id) && typeof o.by === "string" && typeof o.createdAt === "string";
  if (o.version !== 1 || !base) throw new Error("Auftrag: ungültig");
  if (o.action === "freigabe") {
    if (typeof o.target !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(o.target)) throw new Error("Auftrag: Zielversion fehlt");
    if (o.when !== "jetzt" && o.when !== "wartungsfenster") throw new Error("Auftrag: Zeitpunkt jetzt oder wartungsfenster");
    return o as unknown as SystemOrder;
  }
  if (o.action === "kanal") {
    if (o.channel !== "stabil" && o.channel !== "beta") throw new Error("Auftrag: Kanal stabil oder beta");
    return o as unknown as SystemOrder;
  }
  if (o.action === "neustart") return o as unknown as SystemOrder;
  throw new Error("Auftrag: unbekannte Aktion");
}

/**
 * Debian-Supportzeiträume (Sicherheitsteam bzw. LTS, https://wiki.debian.org/LTS). Künftige Versionen mit
 * voraussichtlichen Daten – beim Erscheinen prüfen. Unbekannte Versionen: kein Datum, keine Warnung.
 */
export const DEBIAN_SUPPORT: Record<string, { codename: string; securityUntil: string; ltsUntil: string }> = {
  "12": { codename: "bookworm", securityUntil: "2026-06-10", ltsUntil: "2028-06-30" },
  "13": { codename: "trixie", securityUntil: "2028-08-09", ltsUntil: "2030-06-30" },
};

/** Ab so vielen Monaten vor dem Ende der Sicherheitsupdates empfiehlt die Verwaltung den Versionswechsel (§5a.1). */
export const OS_WARN_MONTHS = 6;

/** /etc/os-release lesen → OsInfo mit Supportdaten (Debian). */
export function parseOsRelease(text: string): OsInfo {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  const versionId = v.VERSION_ID ?? "";
  const support = v.ID === "debian" ? DEBIAN_SUPPORT[versionId] : undefined;
  return {
    name: v.PRETTY_NAME ?? v.NAME ?? "unbekannt",
    versionId,
    codename: v.VERSION_CODENAME ?? support?.codename ?? "",
    securityUntil: support?.securityUntil ?? null,
    ltsUntil: support?.ltsUntil ?? null,
  };
}

export type OsSupportState = "ok" | "wechsel-empfohlen" | "nur-lts" | "abgelaufen" | "unbekannt";

/** Hinweis für die Verwaltung: ab 6 Monaten vor Ende „Versionswechsel empfohlen“, danach LTS bzw. abgelaufen. */
export function osSupportState(os: OsInfo, now = new Date()): OsSupportState {
  if (!os.securityUntil) return "unbekannt";
  const day = now.toISOString().slice(0, 10);
  if (day > (os.ltsUntil ?? os.securityUntil)) return "abgelaufen";
  if (day > os.securityUntil) return "nur-lts";
  const warn = new Date(`${os.securityUntil}T00:00:00Z`);
  warn.setUTCMonth(warn.getUTCMonth() - OS_WARN_MONTHS);
  return day >= warn.toISOString().slice(0, 10) ? "wechsel-empfohlen" : "ok";
}
