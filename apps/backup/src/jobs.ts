// Hintergrundjobs des Backupservers im App-Prozess: jede Minute prüfen, was fällig ist – Aufräumen (täglich), Prüfung (wöchentlich),
// Test-Restore (monatlich), nacheinander.
// Ein Prozess, eine PGlite-Datenbank – eine Sperre im Speicher reicht gegen Doppelläufe.
import { appSecret } from "@/auth/auth";
import type { Db } from "@/db/client";
import { restoreTestContext } from "@/maintenance/restore-test";
import { offsiteConfig } from "@/maintenance/offsite";
import { snapshotConfig } from "@/maintenance/immutable";
import { runAlarms } from "@/alarms";
import { dueFor, maintenancePlan, recordFailure, runCheck, runImmutableFor, runOffsiteFor, runPrune, runRestoreTestFor } from "@/maintenance/service";
import { cleanTmpDir } from "@schulos/server/tmp-aufraeumen";
import { localRestic } from "@/restic/local";
import { forgetPairingResults } from "@/pairing/service";

export function jobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SCHULOS_JOBS === "0") return false;
  return env.SCHULOS_JOBS === "1" || env.NODE_ENV === "production";
}

let busy = false;
let lastAlarmCheck = 0;
let lastTmpCleanup = 0;
/** Alarm-Mails (B-38) höchstens alle 15 Minuten prüfen */
const ALARM_EVERY_MS = 15 * 60_000;

/** Ein Takt; gibt zurück, was getan wurde (für Tests/Log). */
export async function tick(db: Db, now = new Date(), ctx = localRestic(), secret = appSecret()): Promise<string[]> {
  if (busy) return [];
  busy = true;
  const done: string[] = [];
  try {
    try {
      await maintenance(db, now, ctx, secret, done);
    } catch (err) {
      // G4E-O08: ein Fehler in der Wartung (Datenbank, Konfiguration …) darf die Alarme nicht mitreißen
      done.push(`Job-Fehler: ${err instanceof Error ? err.message : String(err)}`);
    }
    // G4E-O18: alte Reste von Test-Restores unter /tmp (Volume backup_tmp) – höchstens stündlich
    if (now.getTime() - lastTmpCleanup >= 3600_000) {
      lastTmpCleanup = now.getTime();
      const removed = cleanTmpDir();
      if (removed.length) done.push(`/tmp aufgeräumt: ${removed.length} alte Einträge`);
    }
    if (now.getTime() - lastAlarmCheck >= ALARM_EVERY_MS) {
      lastAlarmCheck = now.getTime();
      try {
        const r = await runAlarms(db, { now });
        if (r.sent) done.push(`Alarm-Mail gesendet (${r.alarms?.join(", ") || "behoben"})`);
      } catch (err) {
        done.push(`Alarm-Mail fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    busy = false;
  }
  return done;
}

/** Konfiguration einer Wartungsart lesen; ungültig → für jede fällige Instanz als fehlgeschlagener Lauf gebucht (Alarm) */
async function configOrFail<T>(
  db: Db,
  kind: "offsite" | "immutable",
  now: Date,
  at: { at: string; everyDays: number },
  read: () => T | null,
  done: string[],
): Promise<T | null> {
  try {
    return read();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const inst of await dueFor(db, kind, now, at.at, at.everyDays)) await recordFailure(db, inst, kind, error, () => now);
    done.push(`Einstellung ungültig (${kind}): ${error}`);
    return null;
  }
}

/** Wartungsläufe, die jetzt fällig sind (nacheinander) */
async function maintenance(db: Db, now: Date, ctx: ReturnType<typeof localRestic>, secret: string, done: string[]): Promise<void> {
  {
    await forgetPairingResults(db, now);
    const plan = maintenancePlan();
    for (const inst of await dueFor(db, "prune", now, plan.prune.at, plan.prune.everyDays)) {
      const r = await runPrune(db, inst, ctx, secret, null);
      done.push(r.ok ? `aufgeräumt ${inst.name}: ${r.removed} entfernt, ${r.kept} behalten` : `Aufräumen ${inst.name} fehlgeschlagen: ${r.error}`);
    }
    for (const inst of await dueFor(db, "check", now, plan.check.at, plan.check.everyDays)) {
      const r = await runCheck(db, inst, ctx, secret, null);
      done.push(r.ok ? `geprüft ${inst.name}: ok` : `Prüfung ${inst.name} fehlgeschlagen: ${r.error}`);
    }
    for (const inst of await dueFor(db, "restore_test", now, plan.restore_test.at, plan.restore_test.everyDays)) {
      const r = await runRestoreTestFor(db, inst, restoreTestContext(ctx), secret, null);
      done.push(r.ok ? `Test-Restore ${inst.name}: ok ${JSON.stringify(r.details)}` : `Test-Restore ${inst.name} fehlgeschlagen: ${r.error}`);
    }
    const offsite = await configOrFail(db, "offsite", now, plan.offsite, () => offsiteConfig(), done);
    if (offsite)
      for (const inst of await dueFor(db, "offsite", now, plan.offsite.at, plan.offsite.everyDays)) {
        const r = await runOffsiteFor(db, inst, ctx, offsite, secret, null);
        done.push(r.ok ? `Offsite ${inst.name}: ok ${JSON.stringify(r.details)}` : `Offsite ${inst.name} fehlgeschlagen: ${r.error}`);
      }
    // SEC-11: unveränderliche Kopie (Schnappschüsse des Offsite-Ziels); G4E-O08: Tippfehler in der Einstellung → Lauf „fehlgeschlagen“
    const snaps = offsite ? await configOrFail(db, "immutable", now, plan.immutable, () => snapshotConfig(), done) : null;
    if (offsite && snaps)
      for (const inst of await dueFor(db, "immutable", now, plan.immutable.at, plan.immutable.everyDays)) {
        const r = await runImmutableFor(db, inst, ctx, offsite, snaps, null, () => new Date(), secret);
        done.push(r.ok ? `Unveränderliche Kopie ${inst.name}: ${JSON.stringify(r.details)}` : `Unveränderliche Kopie ${inst.name}: ${r.error}`);
      }
  }
}

const globalForJobs = globalThis as unknown as { __backupJobs?: NodeJS.Timeout };

export function startScheduler(db: Db): void {
  if (globalForJobs.__backupJobs) return;
  globalForJobs.__backupJobs = setInterval(() => {
    void tick(db).then(
      (done) => done.forEach((d) => console.log(`[backup] ${d}`)),
      (err) => console.error(`[backup] Job-Fehler: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, 60_000);
  globalForJobs.__backupJobs.unref();
}
