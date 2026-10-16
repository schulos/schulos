// Alarme des Hauptsystems per E-Mail (B-38): Backup überfällig/fehlgeschlagen/nicht eingerichtet, Update fehlgeschlagen,
// Speicherplatz knapp, Abgleich mit dem Server läuft nicht; SEC-14: unveränderliche Kopie veraltet/fehlt, Häufung von
// Fehl-Anmeldungen, neue Admin-/Verwaltungsrechte (security-alarms.ts), Empfänger auch aus Verwaltung → System. Je Ursache einmal, täglich erinnert, „behoben“ beim Verschwinden.
// Keine Personendaten in den Mails – nur Zustände und Zeiten.
import { eq } from "drizzle-orm";
import { alarmMessage, alarmRecipients, DISK_WARN_PERCENT, mailConfig, planAlarms, smtpSender, type Alarm, type AlarmState, type MailConfig, type Sender } from "@schulos/server/mail";
import { immutableHealth } from "@schulos/server/agent-api";
import { collectSecurityAlarms, readAlarmSettings } from "./security-alarms";
import { rebootPendingDays, REBOOT_RED_DAYS, type SystemStatus } from "@schulos/server/system";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import type { BackupStatus } from "@/core/backup/status";
import { backupStatus } from "@/core/backup/status";
import { readSystemStatus, statusIsStale } from "./status";
import { TZ } from "@/core/time";

export const ALARM_STATE_KEY = "alarms.state";
/** Ein fehlgeschlagenes Update bleibt so lange ein Alarm, wenn kein späteres gelungen ist. */
const UPDATE_ALARM_HOURS = 48;

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export function collectAlarms(input: { backup: BackupStatus; system: SystemStatus | null; now: Date }): Alarm[] {
  const out: Alarm[] = [];
  const b = input.backup;
  if (!b.paired)
    out.push({ key: "backup:fehlt", title: "Keine Sicherung eingerichtet", detail: "Unter Verwaltung → Backup einen Backupserver koppeln." });
  else if (b.health === "failed")
    out.push({ key: "backup", title: "Backup fehlgeschlagen", detail: `Letzter Lauf: ${b.lastRun?.error ?? "unbekannter Fehler"}. Verwaltung → Backup prüfen.` });
  else if (b.health === "overdue")
    out.push({
      key: "backup",
      title: "Backup überfällig",
      detail: `Letzte Sicherung: ${b.lastOkAt ? fmt.format(b.lastOkAt) : "noch keine"}. Läuft der Backup-Agent, ist der Backupserver erreichbar?`,
    });
  // SEC-11/SEC-14: unveränderliche Kopie – nur, wenn sie eingerichtet ist (sonst Hinweis in Verwaltung → System)
  const im = b.paired ? immutableHealth(b.immutable ?? null, input.now) : "aus";
  if (im === "veraltet" || im === "fehlt")
    out.push({
      key: "unveraenderlich",
      title: im === "fehlt" ? "Unveränderliche Backup-Kopie fehlt" : "Unveränderliche Backup-Kopie veraltet",
      detail: `${b.immutable?.lastAt ? `Letzte unveränderliche Kopie: ${fmt.format(new Date(b.immutable.lastAt))}. ` : ""}${b.immutable?.error ?? "Schnappschüsse des Offsite-Ziels prüfen"} – sie schützt die Sicherungen, falls Hauptsystem und Backupserver übernommen werden (INSTALLATION.md §4.3a).`,
    });

  const s = input.system;
  if (s) {
    // neueste Einträge zuerst: ein Abbruch ohne späteres „fertig“ innerhalb von 48 h
    const recent = s.protocol.filter((e) => input.now.getTime() - Date.parse(e.at) < UPDATE_ALARM_HOURS * 3600_000);
    const lastDone = recent.find((e) => e.step === "fertig" || e.step === "abbruch");
    if (lastDone?.step === "abbruch")
      out.push({
        key: `update:${lastDone.to ?? "?"}`,
        title: `Update auf ${lastDone.to ?? "neue Version"} fehlgeschlagen`,
        detail: `${lastDone.detail ?? "siehe Protokoll"}. SchulOS ${s.current} läuft weiter; Verwaltung → System zeigt das Protokoll.`,
      });
    if (s.disk && s.disk.usedPercent >= DISK_WARN_PERCENT)
      out.push({ key: "platz", title: `Speicherplatz knapp (${s.disk.usedPercent} % belegt)`, detail: "Alte Dateien prüfen oder die Platte vergrößern – sonst schlagen Sicherungen und Updates fehl." });
    // Q5-18: Passphrase beim Start → das Wartungsfenster startet nicht selbst neu; täglich erinnert, ab 14 Tagen dringend
    if (s.reboot) {
      const days = rebootPendingDays(s.reboot, input.now);
      out.push({
        key: "neustart",
        title: days >= REBOOT_RED_DAYS ? `Neustart seit ${days} Tagen überfällig – Passphrase erforderlich` : "Neustart nötig – Passphrase erforderlich",
        detail:
          "Sicherheitsupdates für Debian werden erst nach einem Neustart wirksam. Die Platte wird per Passphrase entsperrt, deshalb startet das Wartungsfenster nicht selbst neu. Verwaltung → System → „Jetzt neu starten“, danach die Passphrase an der Konsole des Servers eingeben.",
      });
    }
    // G4E-O03 (SEC-14): Platte nicht vollständig an PCR 7+8+9 gebunden (Secure Boot aus, Neu-Binden gescheitert, Übergang hängt …)
    if (s.tpm?.problems.length)
      out.push({
        key: "tpm",
        title: "TPM-Bindung der Platte unvollständig",
        detail: `${s.tpm.problems.join(" ")} Solange nur PCR 7 gilt, entsperrt auch ein fremdes Debian-Startmedium die Platte (INSTALLATION.md §2.3).`,
      });
    if (statusIsStale(s, input.now))
      out.push({ key: "abgleich", title: "Abgleich mit dem Server läuft nicht", detail: "Der Timer schulos-sync.timer meldet sich nicht – Updates und Statusanzeige stehen." });
  }
  return out;
}

async function readState(db: Db): Promise<AlarmState> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, ALARM_STATE_KEY));
  return (row?.value as AlarmState | undefined) ?? {};
}

/** Ein Durchgang: Alarme bestimmen, eine Mail senden, Stand merken. Ohne SMTP-Konfiguration passiert nichts. */
export async function runAlarms(
  db: Db,
  opts: { now?: Date; sender?: Sender; config?: MailConfig | null; server?: string; backup?: BackupStatus; system?: SystemStatus | null } = {},
) {
  // SEC-14: Empfänger aus SCHULOS_ALARM_TO und Verwaltung → System – die Umgebung allein ist nicht mehr Pflicht
  const cfg = opts.config !== undefined ? opts.config : mailConfig(process.env, { alarmTo: false });
  if (!cfg) return { sent: false as const, reason: "keine SMTP-Konfiguration" };
  const now = opts.now ?? new Date();
  const settings = await readAlarmSettings(db);
  const to = alarmRecipients(cfg.to, settings.recipients);
  if (!to.length) return { sent: false as const, reason: "keine Empfänger" };
  const state = await readState(db);
  const active = [
    ...collectAlarms({ backup: opts.backup ?? backupStatus(), system: opts.system !== undefined ? opts.system : readSystemStatus(), now }),
    ...(await collectSecurityAlarms(db, { now, loginAlarmActive: Boolean(state["anmeldung:haeufung"]), settings })),
  ];
  const plan = planAlarms(active, state, now);
  const msg = alarmMessage(opts.server ?? "SchulOS", plan, to);
  // erst senden, dann merken: schlägt das Senden fehl, wird es beim nächsten Durchgang erneut versucht
  if (msg) await (opts.sender ?? smtpSender(cfg))(msg);
  await db
    .insert(appSettings)
    .values({ key: ALARM_STATE_KEY, value: plan.next })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: plan.next, updatedAt: now } });
  return { sent: Boolean(msg), alarms: active.map((a) => a.key) };
}
