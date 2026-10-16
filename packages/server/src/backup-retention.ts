// Aufbewahrung der Sicherungen (INSTALLATION.md §4.2, DATENSCHUTZ.md §3.3/§3.5 LK-BACKUP). Rein; gemeinsam für Backupserver
// (Web-UI, Kopplung) und Installer (Vorgabe für neue Instanzen).
// Die längste Stufe bestimmt, wann gelöschte Daten auch aus den Backups verschwinden – deshalb Warnung über 3 Monaten.

export interface Retention {
  daily: number;
  weekly: number;
  monthly: number;
}

export const DEFAULT_RETENTION: Retention = { daily: 14, weekly: 4, monthly: 3 };
export const LIMITS = { daily: [1, 60], weekly: [0, 26], monthly: [0, 24] } as const;
/** ab hier ist eine Begründung Pflicht (≈ 3 Monate) */
export const WARN_DAYS = 93;

/** Ungefähr so alt wird die älteste Sicherung (Tage). */
export function oldestDays(r: Retention): number {
  return Math.max(r.daily, r.weekly * 7, Math.round(r.monthly * 30.44));
}

export interface RetentionPreview {
  /** höchstens so viele Stände bleiben (bei täglicher Sicherung) */
  maxSnapshots: number;
  oldestDays: number;
  /** „≈ 3 Monate“, „≈ 4 Wochen“, „14 Tage“ */
  oldestLabel: string;
  needsReason: boolean;
}

export function preview(r: Retention): RetentionPreview {
  const days = oldestDays(r);
  const oldestLabel = days >= 60 ? `≈ ${Math.round(days / 30.44)} Monate` : days >= 14 && days % 7 === 0 ? `${days / 7} Wochen` : `${days} Tage`;
  return { maxSnapshots: r.daily + r.weekly + r.monthly, oldestDays: days, oldestLabel, needsReason: days > WARN_DAYS };
}

export interface RetentionInput {
  daily: string;
  weekly: string;
  monthly: string;
  reason: string;
}

/** Formulareingaben prüfen; Fehler je Feld. */
export function parseRetention(input: RetentionInput): { ok: true; retention: Retention; reason: string | null } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out = {} as Retention;
  for (const key of ["daily", "weekly", "monthly"] as const) {
    const n = Number(input[key]);
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) errors[key] = `${min} bis ${max}`;
    else out[key] = n;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const reason = input.reason.trim();
  if (preview(out).needsReason && reason.length < 10)
    return { ok: false, errors: { reason: "Länger als 3 Monate nur mit Begründung (mindestens 10 Zeichen) – siehe Löschkonzept" } };
  return { ok: true, retention: out, reason: preview(out).needsReason ? reason.slice(0, 500) : null };
}

/** Uhrzeiten „HH:MM“, 1 bis 4, sortiert und ohne Dubletten. */
export function parseSchedule(input: string): { ok: true; schedule: string[] } | { ok: false; error: string } {
  const parts = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  if (parts.length === 0) return { ok: false, error: "Mindestens eine Uhrzeit, z. B. 01:30" };
  if (parts.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return { ok: false, error: "Uhrzeiten im Format HH:MM, z. B. 01:30, 12:30" };
  const schedule = [...new Set(parts)].sort();
  if (schedule.length > 4) return { ok: false, error: "Höchstens vier Uhrzeiten am Tag" };
  return { ok: true, schedule };
}

/**
 * Vorgabe für neu gekoppelte Instanzen aus der Umgebung (Installer, INSTALLATION.md §3.3): SCHULOS_RETENTION=„14/4/3“
 * (täglich/wöchentlich/monatlich), über 3 Monate nur mit SCHULOS_RETENTION_REASON. Ohne Angabe 14/4/3; ungültige Angaben
 * brechen ab, statt still die Vorgabe zu nehmen.
 */
export function retentionFromEnv(env: Record<string, string | undefined>): { retention: Retention; reason: string | null } {
  const raw = env.SCHULOS_RETENTION?.trim();
  if (!raw) return { retention: DEFAULT_RETENTION, reason: null };
  const [daily = "", weekly = "", monthly = ""] = raw.split("/").map((s) => s.trim());
  const r = parseRetention({ daily, weekly, monthly, reason: env.SCHULOS_RETENTION_REASON ?? "" });
  if (!r.ok) throw new Error(`SCHULOS_RETENTION="${raw}": ${Object.entries(r.errors).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return { retention: r.retention, reason: r.reason };
}
