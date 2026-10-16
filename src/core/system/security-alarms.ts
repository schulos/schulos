// SEC-14: Sicherheitsalarme per Mail – ergänzt die Betriebsalarme (B-38) um Häufung von Fehl-Anmeldungen (Schwelle je Schule),
// neue Admin-/Verwaltungsrechte (Ereignis, einmal gemeldet) und zusätzliche Empfänger aus Verwaltung → System. Die Mails
// enthalten keine Personendaten: nur Anzahlen, Rechte und Zeitpunkte; wer was vergeben hat, steht im Protokoll.
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { isMailAddress, type Alarm } from "@schulos/server/mail";
import { audit } from "@/core/audit";
import { enqueueMail } from "@/core/mail";
import type { Db } from "@/core/db/client";
import { appSettings, auditLog, authThrottle } from "@/core/db/schema";

export const ALARM_SETTINGS_KEY = "system.alarme";
/** Fehl-Anmeldungen je Stunde (alle Konten zusammen), ab denen ein Alarm kommt */
export const LOGIN_ALARM_DEFAULT = 50;
export const LOGIN_ALARM_MIN = 5;
export const LOGIN_ALARM_MAX = 10_000;
/** Rechte-Ereignisse so lange aktiv halten (in diesem Fenster einmal gemeldet) */
export const RIGHTS_EVENT_HOURS = 24;
/** gleiche Präfixe wie die Anmeldesperre (@schulos/server/throttle: userKey/ipKey) – Test prüft */
export const THROTTLE_PREFIXES = ["u:", "ip:"] as const;

export interface AlarmSettings {
  /** zusätzliche Empfänger (neben SCHULOS_ALARM_TO) */
  recipients: string[];
  loginThreshold: number;
}

export async function readAlarmSettings(db: Db): Promise<AlarmSettings> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, ALARM_SETTINGS_KEY));
  const v = (row?.value ?? {}) as Partial<AlarmSettings>;
  const recipients = Array.isArray(v.recipients)
    ? v.recipients.filter(
        (x): x is string => typeof x === "string" && isMailAddress(x),
      )
    : [];
  const t = Number(v.loginThreshold);
  return {
    recipients,
    loginThreshold:
      Number.isInteger(t) && t >= LOGIN_ALARM_MIN && t <= LOGIN_ALARM_MAX
        ? t
        : LOGIN_ALARM_DEFAULT,
  };
}

export class AlarmSettingsError extends Error {}

/** Empfänger (Komma/Zeilen) und Schwelle prüfen und speichern; Rechteprüfung macht der Aufrufer, Änderung im Protokoll. */
export async function saveAlarmSettings(
  db: Db,
  actorId: string,
  input: { recipients: string; loginThreshold: string },
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): Promise<AlarmSettings> {
  const recipients = input.recipients
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const bad = recipients.find((a) => !isMailAddress(a));
  if (bad) throw new AlarmSettingsError(`„${bad}“ ist keine E-Mail-Adresse`);
  if (recipients.length > 10)
    throw new AlarmSettingsError("Höchstens 10 zusätzliche Empfänger");
  const t = Number(input.loginThreshold);
  if (!Number.isInteger(t) || t < LOGIN_ALARM_MIN || t > LOGIN_ALARM_MAX)
    throw new AlarmSettingsError(
      `Schwelle: ganze Zahl von ${LOGIN_ALARM_MIN} bis ${LOGIN_ALARM_MAX}`,
    );
  const value: AlarmSettings = {
    recipients: [...new Set(recipients)],
    loginThreshold: t,
  };
  // G4E-O12: ohne SCHULOS_ALARM_TO wären Alarme mit leerer Liste still – das soll niemand (auch kein übernommenes Konto) einstellen
  const fromEnv = envRecipients(env);
  if (!value.recipients.length && !fromEnv.length)
    throw new AlarmSettingsError(
      "Mindestens ein Empfänger – SCHULOS_ALARM_TO ist auf diesem Server nicht gesetzt, sonst kämen keine Alarme mehr an.",
    );
  const before = await readAlarmSettings(db);
  await db
    .insert(appSettings)
    .values({ key: ALARM_SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
  await audit(db, actorId, "system.alarme.einstellungen", null, {
    empfaenger: value.recipients.length,
    schwelle: t,
  });
  // G4E-O12: die Änderung selbst melden – an die bisherigen UND die neuen Empfänger (und SCHULOS_ALARM_TO). Wer Alarme vor einer
  // Rechte-Ausweitung abschalten will, löst damit selbst einen aus. Nur Anzahlen, keine Adressen.
  const changed =
    before.loginThreshold !== value.loginThreshold ||
    before.recipients.length !== value.recipients.length ||
    before.recipients.some((r) => !value.recipients.includes(r));
  if (changed) {
    const to = [...new Set([...fromEnv, ...before.recipients, ...value.recipients].map((a) => a.toLowerCase()))];
    const text = [
      `Die Alarm-Einstellungen von SchulOS wurden am ${now.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} geändert (Verwaltung → System).`,
      "",
      `Zusätzliche Empfänger: vorher ${before.recipients.length}, jetzt ${value.recipients.length}${before.recipients.some((r) => !value.recipients.includes(r)) ? " (mindestens einer entfernt)" : ""}`,
      `Schwelle Fehl-Anmeldungen je Stunde: vorher ${before.loginThreshold}, jetzt ${value.loginThreshold}`,
      "",
      "War das nicht gewollt, bitte sofort prüfen – wer es war, steht unter Verwaltung → Protokoll (system.alarme.einstellungen).",
    ].join("\n");
    for (const addr of to) await enqueueMail(db, { to: addr, subject: "[SchulOS] Alarm-Einstellungen geändert", text, purpose: "alarm-einstellungen" }, now);
  }
  return value;
}

/** Empfänger aus SCHULOS_ALARM_TO (nur gültige Adressen) */
function envRecipients(env: Record<string, string | undefined>): string[] {
  return (env.SCHULOS_ALARM_TO ?? "")
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter((a) => a && isMailAddress(a));
}

/**
 * Fehl-Anmeldungen der letzten Stunde, schulweit: Summe der Zähler aus der Anmeldesperre (B-10), je Benutzername bzw. je
 * Adresse – der größere Wert zählt (unbekannte Namen zählen nur je Adresse). Nur Anzahlen, keine Namen.
 */
export async function failedLoginsLastHour(
  db: Db,
  now = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 3600_000);
  const sum = async (prefix: string) => {
    const [row] = await db
      .select({
        n: sql<
          string | number | null
        >`coalesce(sum(${authThrottle.failures}), 0)`,
      })
      .from(authThrottle)
      .where(
        and(
          like(authThrottle.key, `${prefix}%`),
          gte(authThrottle.updatedAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  };
  return Math.max(...(await Promise.all(THROTTLE_PREFIXES.map(sum))));
}

/** Rechte, deren Vergabe immer gemeldet wird: Vollrecht und alles unter verwaltung.* */
export function isSensitivePermission(p: unknown): boolean {
  return typeof p === "string" && (p === "*" || p.startsWith("verwaltung."));
}

const SENSITIVE_ROLES = new Set(["admin", "verwaltung"]);

export interface RightsEvent {
  id: number;
  at: Date;
  text: string;
}

/** Neue Admin-/Verwaltungsrechte der letzten 24 h (S15): Recht vergeben (Rolle/Gruppe) und Konten mit Rolle Admin/Verwaltung angelegt */
export async function rightsEvents(
  db: Db,
  now = new Date(),
): Promise<RightsEvent[]> {
  const since = new Date(now.getTime() - RIGHTS_EVENT_HOURS * 3600_000);
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      meta: auditLog.meta,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, [
          "verwaltung.rights.grant",
          "verwaltung.user.create",
        ]),
        gte(auditLog.createdAt, since),
      ),
    );
  const out: RightsEvent[] = [];
  for (const r of rows) {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    if (
      r.action === "verwaltung.rights.grant" &&
      isSensitivePermission(meta.permission)
    ) {
      const where = r.target?.startsWith("role:")
        ? `Rolle ${r.target.slice(5)}`
        : "eine Gruppe";
      out.push({
        id: r.id,
        at: r.createdAt,
        text: `Recht „${String(meta.permission)}“ an ${where} vergeben`,
      });
    }
    if (
      r.action === "verwaltung.user.create" &&
      typeof meta.role === "string" &&
      SENSITIVE_ROLES.has(meta.role)
    )
      out.push({
        id: r.id,
        at: r.createdAt,
        text: `Konto mit Rolle ${meta.role} angelegt`,
      });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Sicherheitsalarme aus den Messwerten (rein). Entprellung der Fehl-Anmeldungen: ein laufender Alarm bleibt, bis die Zahl
 * unter die halbe Schwelle fällt (kein Hin und Her an der Grenze).
 */
export function securityAlarms(input: {
  failedLogins: number;
  threshold: number;
  loginAlarmActive: boolean;
  rights: RightsEvent[];
}): Alarm[] {
  const out: Alarm[] = [];
  const limit = input.loginAlarmActive
    ? Math.ceil(input.threshold / 2)
    : input.threshold;
  if (input.failedLogins >= limit)
    out.push({
      key: "anmeldung:haeufung",
      title: `Häufung fehlgeschlagener Anmeldungen (${input.failedLogins} in der letzten Stunde)`,
      detail: `Schwelle ${input.threshold} je Stunde. Gesperrte Konten stehen unter Verwaltung → Übersicht, Einzelheiten im Protokoll. Ein Angriff von außen? Außenzugang und Gerätezertifikate prüfen.`,
    });
  for (const e of input.rights)
    out.push({
      key: `rechte:${e.id}`,
      title: `Neue Admin-/Verwaltungsrechte: ${e.text}`,
      detail:
        "Bitte prüfen, ob das so gewollt war – wer es war, steht unter Verwaltung → Protokoll (Rechte bzw. Benutzer).",
      event: true,
    });
  return out;
}

/** Alles Nötige für die Sicherheitsalarme aus der Datenbank */
export async function collectSecurityAlarms(
  db: Db,
  opts: { now: Date; loginAlarmActive: boolean; settings?: AlarmSettings },
): Promise<Alarm[]> {
  const settings = opts.settings ?? (await readAlarmSettings(db));
  const [failedLogins, rights] = await Promise.all([
    failedLoginsLastHour(db, opts.now),
    rightsEvents(db, opts.now),
  ]);
  return securityAlarms({
    failedLogins,
    threshold: settings.loginThreshold,
    loginAlarmActive: opts.loginAlarmActive,
    rights,
  });
}
