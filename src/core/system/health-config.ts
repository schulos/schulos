// BM-02/BM-04: Betriebsart und Schwellen des Betriebsstatus – rein (auch im Browser-Code der Verwaltung nutzbar).

export const HEALTH_SETTINGS_KEY = "system.health";

/** aus: Endpunkt antwortet 404 · schulnetz: nur Anfragen aus dem Schulnetz · token: nur mit Token (`Authorization: Bearer …`) */
export const HEALTH_MODES = ["aus", "schulnetz", "token"] as const;
export type HealthMode = (typeof HEALTH_MODES)[number];
export const HEALTH_MODE_LABEL: Record<HealthMode, string> = { aus: "aus", schulnetz: "nur aus dem Schulnetz", token: "nur mit Token" };

export const MAIL_BACKLOG_DEFAULT = 60;
export const MAIL_BACKLOG_MIN = 5;
export const MAIL_BACKLOG_MAX = 1440;
export const BACKUP_HOURS_DEFAULT = 26;
export const BACKUP_HOURS_MIN = 6;
export const BACKUP_HOURS_MAX = 168;

export interface HealthSettings {
  mode: HealthMode;
  /** ältester unversendeter Mail-Eintrag (Minuten), ab dem „Mail-Stau“ gilt */
  mailBacklogMinutes: number;
  /** Alter der letzten guten Sicherung (Stunden), ab dem gewarnt wird (die Backup-Ampel selbst bleibt unverändert) */
  backupMaxHours: number;
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = { mode: "schulnetz", mailBacklogMinutes: MAIL_BACKLOG_DEFAULT, backupMaxHours: BACKUP_HOURS_DEFAULT };

const inRange = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

export function parseHealthSettings(raw: unknown): HealthSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: HEALTH_MODES.includes(v.mode as HealthMode) ? (v.mode as HealthMode) : DEFAULT_HEALTH_SETTINGS.mode,
    mailBacklogMinutes: inRange(v.mailBacklogMinutes, MAIL_BACKLOG_MIN, MAIL_BACKLOG_MAX, MAIL_BACKLOG_DEFAULT),
    backupMaxHours: inRange(v.backupMaxHours, BACKUP_HOURS_MIN, BACKUP_HOURS_MAX, BACKUP_HOURS_DEFAULT),
  };
}

