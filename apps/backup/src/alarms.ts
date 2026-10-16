// Alarme des Backupservers per E-Mail (B-38): je Instanz Backup überfällig/fehlgeschlagen und fehlgeschlagene Wartung
// (Aufräumen, Prüfung, Test-Restore, Offsite), dazu Speicherplatz des Repository-Ordners. Gleiche Regeln wie im
// Hauptsystem (@schulos/server/mail): einmal, täglich erinnert, „behoben“ beim Verschwinden.
import { statfsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { alarmMessage, DISK_WARN_PERCENT, mailConfig, planAlarms, smtpSender, type Alarm, type AlarmState, type MailConfig, type Sender } from "@schulos/server/mail";
import { instanceStatus } from "@/agent/service";
import type { Db } from "@/db/client";
import { settings } from "@/db/schema";
import { snapshotConfig } from "@/maintenance/immutable";
import { offsiteConfig } from "@/maintenance/offsite";
import { lastMaintenance, maintenancePlan, type MaintenanceKind } from "@/maintenance/service";
import { listInstances } from "@/pairing/service";
import { restDir, serverName } from "@/settings";
import { hostAlarms, readHostStatus, type HostStatus } from "@schulos/server/host-status";

export const ALARM_STATE_KEY = "alarms.state";

const KIND_LABEL: Record<MaintenanceKind, string> = { prune: "Aufräumen", check: "Prüfung", restore_test: "Test-Restore", offsite: "Offsite-Kopie", immutable: "Unveränderliche Kopie" };

/** belegter Anteil des Repository-Ordners in Prozent (null, wenn nicht ermittelbar) */
export function diskUsedPercent(dir = restDir()): number | null {
  try {
    const s = statfsSync(dir);
    return s.blocks ? Math.round(((s.blocks - s.bavail) / s.blocks) * 100) : null;
  } catch {
    return null;
  }
}

export async function collectAlarms(
  db: Db,
  now = new Date(),
  disk = diskUsedPercent(),
  host: HostStatus | null = readHostStatus(),
  env: Record<string, string | undefined> = process.env,
): Promise<Alarm[]> {
  // SEC-14/Q5-18: Neustart nötig, aber nur mit Passphrase möglich (Status vom Host)
  const out: Alarm[] = [...hostAlarms(host, now)];
  const plan = maintenancePlan(env);
  const configured = (read: () => unknown) => {
    try {
      return read() !== null;
    } catch {
      return true; // ungültig: Fehlschläge bucht der Takt (G4E-O08)
    }
  };
  const active = new Set<MaintenanceKind>(["prune", "check", "restore_test"]);
  if (configured(() => offsiteConfig(env))) {
    active.add("offsite");
    if (configured(() => snapshotConfig(env))) active.add("immutable");
  }
  for (const inst of await listInstances(db)) {
    const s = await instanceStatus(db, inst.id, now);
    if (s.health === "overdue")
      out.push({ key: `backup:${inst.id}`, title: `Backup überfällig: ${inst.name}`, detail: "Seit über 26 Stunden keine erfolgreiche Sicherung – läuft das Hauptsystem, erreicht es den Backupserver?" });
    if (s.health === "failed")
      out.push({ key: `backup:${inst.id}`, title: `Backup fehlgeschlagen: ${inst.name}`, detail: s.lastRun?.error ?? "Fehler im letzten Lauf – Instanzseite prüfen." });
    for (const kind of Object.keys(KIND_LABEL) as MaintenanceKind[]) {
      const last = await lastMaintenance(db, inst.id, kind);
      if (last?.status === "failed")
        out.push({ key: `${kind}:${inst.id}`, title: `${KIND_LABEL[kind]} fehlgeschlagen: ${inst.name}`, detail: last.error ?? "siehe Instanzseite" });
      // G4E-O08: letzter Lauf älter als zweimal der Abstand (+1 Tag) – der Takt steht oder die Wartung wird übersprungen
      else if (last && active.has(kind) && now.getTime() - last.startedAt.getTime() > (2 * plan[kind].everyDays + 1) * 86_400_000)
        out.push({
          key: `${kind}-alt:${inst.id}`,
          title: `${KIND_LABEL[kind]} läuft nicht mehr: ${inst.name}`,
          detail: `Letzter Lauf am ${last.startedAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} – vorgesehen alle ${plan[kind].everyDays} Tag(e). Protokoll des Backupservers prüfen (docker compose logs backup).`,
        });
    }
  }
  if (disk !== null && disk >= DISK_WARN_PERCENT)
    out.push({ key: "platz", title: `Speicherplatz knapp (${disk} % belegt)`, detail: "Aufbewahrung verkürzen oder Platten erweitern – sonst schlagen die nächsten Sicherungen fehl." });
  return out;
}

export async function runAlarms(db: Db, opts: { now?: Date; sender?: Sender; config?: MailConfig | null; disk?: number | null } = {}) {
  const cfg = opts.config !== undefined ? opts.config : mailConfig();
  if (!cfg) return { sent: false as const };
  const now = opts.now ?? new Date();
  const active = await collectAlarms(db, now, opts.disk !== undefined ? opts.disk : diskUsedPercent());
  const [row] = await db.select().from(settings).where(eq(settings.key, ALARM_STATE_KEY));
  const plan = planAlarms(active, (row?.value as AlarmState | undefined) ?? {}, now);
  const msg = alarmMessage(serverName(), plan, cfg.to);
  if (msg) await (opts.sender ?? smtpSender(cfg))(msg);
  await db.insert(settings).values({ key: ALARM_STATE_KEY, value: plan.next }).onConflictDoUpdate({ target: settings.key, set: { value: plan.next, updatedAt: now } });
  return { sent: Boolean(msg), alarms: active.map((a) => a.key) };
}
