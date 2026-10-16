// Schnittstelle Backup-Agent (Hauptsystem) ↔ Backupserver (INSTALLATION.md §4.1). Rein, gemeinsam für Agent, Backupserver und Hauptsystem.
// Der Agent fragt jede Minute den Plan ab (Zeitplan, angeforderte Sicherung), sichert und meldet das Ergebnis.
// Authentifizierung: Agent-Token aus der Kopplung (Authorization: Bearer …), TLS gegen die gepinnte CA.

/** Ohne erfolgreiche Sicherung seit so vielen Stunden gilt eine Instanz als überfällig (rote Warnung). */
export const OVERDUE_HOURS = 26;
/** Ein verpasster Termin (Hauptsystem war aus) wird noch so lange nachgeholt. */
export const CATCH_UP_HOURS = 12;

export type RunTrigger = "zeitplan" | "angefordert" | "vor-wiederherstellung";

export interface AgentPlan {
  instanceId: string;
  instanceName: string;
  /** Uhrzeiten „HH:MM“ in Europe/Berlin */
  schedule: string[];
  /** „Jetzt sichern“ angefordert (ISO) – der Agent meldet diesen Zeitpunkt im Ergebnis zurück, dann gilt er als erledigt */
  runRequestedAt: string | null;
  /** offener Wiederherstellungsauftrag (wartet auf Bestätigung oder ist bestätigt) */
  restore?: RestoreRequest | null;
  /** SEC-11: letzte unveränderliche Kopie (Schnappschüsse des Offsite-Ziels); null = nicht eingerichtet, fehlt = alter Backupserver */
  immutable?: ImmutableCopy | null;
}

/** SEC-11: Ergebnis der täglichen Prüfung „letzte unveränderliche Kopie“ auf dem Backupserver */
export interface ImmutableCopy {
  /** Zeitpunkt des neuesten Schnappschusses mit der Offsite-Kopie dieser Instanz (ISO) bzw. null, wenn keiner gefunden */
  lastAt: string | null;
  /** wann geprüft (ISO) */
  checkedAt: string;
  ok: boolean;
  /** kurze Meldung ohne Personendaten */
  error: string | null;
}

/** Älter als so viele Stunden gilt die unveränderliche Kopie als veraltet (Alarm) */
export const IMMUTABLE_MAX_HOURS = 48;

/** Kommt vom Backupserver (nicht vertrauenswürdig): nur gültige Zeitangaben und kurze Texte übernehmen. */
export function sanitizeImmutable(x: unknown): ImmutableCopy | null {
  if (!x || typeof x !== "object") return null;
  const c = x as Partial<ImmutableCopy>;
  const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const checkedAt = iso(c.checkedAt);
  if (!checkedAt) return null;
  return { lastAt: iso(c.lastAt), checkedAt, ok: c.ok === true, error: typeof c.error === "string" ? c.error.slice(0, 300) : null };
}

export type ImmutableHealth = "ok" | "veraltet" | "fehlt" | "aus";

/** Ampel der unveränderlichen Kopie: aus = nicht eingerichtet; fehlt = Prüfung fehlgeschlagen ohne Stand; veraltet = zu alt bzw. Prüfung alt */
export function immutableHealth(c: ImmutableCopy | null | undefined, now = new Date(), maxHours = IMMUTABLE_MAX_HOURS): ImmutableHealth {
  if (!c) return "aus";
  if (!c.lastAt) return "fehlt";
  const age = now.getTime() - Date.parse(c.lastAt);
  // die Prüfung selbst läuft täglich – liegt sie zwei Tage zurück, ist der Stand nicht mehr belastbar
  const checked = now.getTime() - Date.parse(c.checkedAt);
  if (!c.ok || age > maxHours * 3600_000 || checked > maxHours * 3600_000) return "veraltet";
  return "ok";
}

export const IMMUTABLE_LABEL: Record<ImmutableHealth, string> = {
  ok: "vorhanden",
  veraltet: "veraltet",
  fehlt: "fehlt",
  aus: "nicht eingerichtet",
};

export interface AgentReport {
  trigger: RunTrigger;
  status: "ok" | "failed";
  startedAt: string;
  finishedAt: string;
  snapshotId?: string | null;
  bytesTotal?: number | null;
  bytesAdded?: number | null;
  /** kurze Fehlermeldung ohne Personendaten */
  error?: string | null;
  agentVersion: string;
  requestedAt?: string | null;
}

export type BackupHealth = "ok" | "overdue" | "failed" | "none";

/** Ampel: kein Lauf → none; letzter Lauf fehlgeschlagen → failed; letzte erfolgreiche Sicherung zu alt → overdue. */
export function backupHealth(lastOkAt: Date | null, lastRun: { status: string } | null, now = new Date()): BackupHealth {
  if (!lastRun && !lastOkAt) return "none";
  if (lastRun?.status === "failed") return "failed";
  if (!lastOkAt || now.getTime() - lastOkAt.getTime() > OVERDUE_HOURS * 3600_000) return "overdue";
  return "ok";
}

export const HEALTH_LABEL: Record<BackupHealth, string> = {
  ok: "gesichert",
  overdue: "überfällig",
  failed: "fehlgeschlagen",
  none: "noch kein Backup",
};

const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** „YYYY-MM-DD HH:MM“ in Europe/Berlin – vergleichbar als Text. */
export function berlinStamp(d: Date): string {
  const p = Object.fromEntries(berlin.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function isValidSlot(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/**
 * Fälliger Termin oder null. Ein Termin ist fällig, wenn seine Uhrzeit heute (bzw. gestern, kurz nach Mitternacht) vorbei ist,
 * höchstens CATCH_UP_HOURS zurückliegt und noch nicht gelaufen ist (`lastSlot` = zuletzt ausgeführter Termin, „YYYY-MM-DD HH:MM“).
 * Liegen mehrere offen, zählt nur der jüngste – verpasste Läufe werden nicht einzeln nachgeholt.
 */
export function dueSlot(schedule: string[], now: Date, lastSlot: string | null): string | null {
  const nowStamp = berlinStamp(now);
  const earliest = berlinStamp(new Date(now.getTime() - CATCH_UP_HOURS * 3600_000));
  const days = [berlinStamp(new Date(now.getTime() - 24 * 3600_000)).slice(0, 10), nowStamp.slice(0, 10)];
  const candidates = days
    .flatMap((day) => schedule.filter(isValidSlot).map((t) => `${day} ${t}`))
    .filter((slot) => slot <= nowStamp && slot >= earliest && (!lastSlot || slot > lastSlot))
    .sort();
  return candidates.at(-1) ?? null;
}

/** Zustand des Agenten im Konfigurationsordner (backup-agent-state.json) – das Hauptsystem liest ihn für Verwaltung → Backup. */
export interface AgentState {
  version: 1;
  /** gehört zu dieser Kopplung; bei neuer Kopplung beginnt der Zustand von vorn */
  instanceId: string | null;
  repoInitializedAt: string | null;
  /** zuletzt ausgeführter Termin „YYYY-MM-DD HH:MM“ (Europe/Berlin) */
  lastSlot: string | null;
  /** zuletzt erledigte Anforderung „Jetzt sichern“ (ISO) */
  lastRequestHandled: string | null;
  lastRun: (Omit<AgentReport, "agentVersion" | "requestedAt"> & { trigger: RunTrigger }) | null;
  lastOkAt: string | null;
  /** Meldung, die den Backupserver noch nicht erreicht hat */
  pendingReport: AgentReport | null;
  lastContactAt: string | null;
  lastContactError: string | null;
  /** läuft gerade eine Sicherung (seit) */
  runningSince: string | null;
  /** offener Wiederherstellungsauftrag aus dem letzten Plan – Verwaltung → Backup zeigt ihn zur Bestätigung an */
  restoreRequest?: RestoreRequest | null;
  /** SEC-11: letzte unveränderliche Kopie laut Backupserver (aus dem letzten Plan) */
  immutable?: ImmutableCopy | null;
  /** letzte Wiederherstellung */
  lastRestore?: { id: string; scope: RestoreScope; snapshotShort: string; status: "fertig" | "fehlgeschlagen"; finishedAt: string; error: string | null } | null;
}

export function emptyAgentState(instanceId: string | null = null): AgentState {
  return {
    version: 1,
    instanceId,
    repoInitializedAt: null,
    lastSlot: null,
    lastRequestHandled: null,
    lastRun: null,
    lastOkAt: null,
    pendingReport: null,
    lastContactAt: null,
    lastContactError: null,
    runningSince: null,
    restoreRequest: null,
    lastRestore: null,
  };
}

// ---------------------------------------------------------------- Wiederherstellung (B-27, INSTALLATION.md §4.4)

export type RestoreScope = "komplett" | "dateien";
export type RestoreStatus = "wartet" | "bestaetigt" | "laeuft" | "fertig" | "fehlgeschlagen" | "abgelehnt";

/** Auftrag „auf Hauptsystem wiederherstellen“ – kommt mit dem Plan, läuft erst nach Bestätigung mit dem Code auf dem Hauptsystem. */
export interface RestoreRequest {
  id: string;
  snapshotId: string;
  snapshotShort: string;
  snapshotTime: string;
  scope: RestoreScope;
  /** Name der Person auf dem Backupserver */
  requestedBy: string | null;
  createdAt: string;
  status: "wartet" | "bestaetigt";
}

export const RESTORE_SCOPE_LABEL: Record<RestoreScope, string> = {
  komplett: "komplett (Datenbank und Dateien – alles seitdem Eingegebene geht verloren)",
  dateien: "nur fehlende Dateien (vorhandene bleiben unverändert)",
};

/** Meldung des Agenten zum Fortschritt bzw. Ergebnis eines Auftrags. */
export interface RestoreReport {
  id: string;
  status: "laeuft" | "fertig" | "fehlgeschlagen";
  error?: string | null;
  /** Kennzahlen, z. B. { sicherungVorher: "ok", dateien: 12 } – keine Inhalte */
  details?: Record<string, unknown> | null;
}

/** Vollständige restic-Snapshot-ID (SEC-06): nur so geht eine ID an restic – nie etwas, das wie eine Option aussieht. */
export const SNAPSHOT_ID = /^[0-9a-f]{64}$/;

/** Prüft einen Auftrag aus dem Plan (kommt vom Backupserver, also nicht vertrauenswürdig); null = in Ordnung. */
export function restoreRequestProblem(r: unknown): string | null {
  if (!r || typeof r !== "object") return "kein Auftrag";
  const q = r as Partial<RestoreRequest>;
  if (typeof q.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(q.id)) return "Auftragsnummer ungültig";
  if (typeof q.snapshotId !== "string" || !SNAPSHOT_ID.test(q.snapshotId)) return "Stand ungültig";
  if (typeof q.snapshotShort !== "string" || q.snapshotShort !== q.snapshotId.slice(0, q.snapshotShort.length) || q.snapshotShort.length < 8)
    return "Kurzform des Stands passt nicht";
  if (q.scope !== "komplett" && q.scope !== "dateien") return "Umfang unbekannt";
  if (q.status !== "wartet" && q.status !== "bestaetigt") return "Status unbekannt";
  return null;
}

/**
 * Freigabe auf dem Hauptsystem (SEC-06): Die App schreibt sie in den Konfigurationsordner, sobald die Admin den Code
 * eingibt (Recht verwaltung.system) – der Backupserver kann dort nicht schreiben. Der Agent führt einen „bestätigten“
 * Auftrag nur aus, wenn diese Freigabe genau dazu passt (Auftrag, Stand, Umfang) und noch gilt; danach löscht er sie.
 */
export const RESTORE_APPROVAL_FILE = "restore-approval.json";
export const RESTORE_APPROVAL_MINUTES = 30;

export interface RestoreApproval {
  id: string;
  snapshotId: string;
  scope: RestoreScope;
  approvedAt: string;
  until: string;
}

export function restoreApproval(req: RestoreRequest, now = new Date()): RestoreApproval {
  return {
    id: req.id,
    snapshotId: req.snapshotId,
    scope: req.scope,
    approvedAt: now.toISOString(),
    until: new Date(now.getTime() + RESTORE_APPROVAL_MINUTES * 60_000).toISOString(),
  };
}

/** Passt die Freigabe zum Auftrag? null = ja, sonst der Grund. */
export function approvalProblem(a: unknown, req: RestoreRequest, now = new Date()): string | null {
  if (!a || typeof a !== "object") return "keine Freigabe auf dem Hauptsystem";
  const f = a as Partial<RestoreApproval>;
  if (f.id !== req.id || f.snapshotId !== req.snapshotId || f.scope !== req.scope) return "Freigabe passt nicht zum Auftrag";
  const until = typeof f.until === "string" ? Date.parse(f.until) : NaN;
  if (!(until > now.getTime())) return "Freigabe abgelaufen";
  return null;
}

/** Bestätigungscode: 6 Ziffern, auf dem Backupserver angezeigt, auf dem Hauptsystem einzugeben. */
export function normalizeRestoreCode(input: string): string | null {
  const s = input.replace(/\s/g, "");
  return /^\d{6}$/.test(s) ? s : null;
}

/** Wartungsmodus des Hauptsystems (Datei im Konfigurationsordner, schreibt der Agent): die App antwortet mit 503. */
export const MAINTENANCE_FILE = "maintenance.json";

export interface MaintenanceState {
  since: string;
  reason: string;
  /** "neustart": Wiederherstellung fertig – die App beendet sich, Docker startet sie neu, die Migrationen laufen */
  phase: "wartung" | "neustart";
}
