import type { Metadata } from "next";
import Link from "next/link";
import { HEALTH_LABEL, type BackupHealth } from "@schulos/server/agent-api";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { instanceStatus } from "@/agent/service";
import { getDb } from "@/db/client";
import { lastMaintenance } from "@/maintenance/service";
import { offsiteConfig } from "@/maintenance/offsite";
import { mailConfig } from "@schulos/server/mail";
import { TestMailForm } from "./mail-form";
import { listInstances } from "@/pairing/service";
import { formatBytes } from "@/lib/format";
import { HOST_REBOOT_RED_DAYS, hostStatusStale, hostTpmProblems, pendingPassphraseReboot, readHostStatus } from "@schulos/server/host-status";

export const metadata: Metadata = { title: "Übersicht" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
const TONE: Record<BackupHealth, "success" | "warn" | "danger" | "neutral"> = { ok: "success", overdue: "danger", failed: "danger", none: "warn" };

export default async function Overview() {
  const db = await getDb();
  const list = await listInstances(db);
  const status = await Promise.all(list.map((i) => instanceStatus(db, i.id)));
  const tests = await Promise.all(list.map((i) => lastMaintenance(db, i.id, "restore_test")));
  const offsite = offsiteConfig();
  let mail: { to: string[] } | null = null;
  let mailError: string | null = null;
  try {
    mail = mailConfig();
  } catch (err) {
    mailError = err instanceof Error ? err.message : String(err);
  }
  const copies = await Promise.all(list.map((i) => lastMaintenance(db, i.id, "offsite")));
  // SEC-14/Q5-18: Neustart nötig, aber nur mit Passphrase (Status vom Host, schulos-hoststatus.timer)
  const host = readHostStatus();
  const rebootDays = pendingPassphraseReboot(host);
  // G4E-O03/O15: TPM2-Bindung vollständig? Host-Status aktuell?
  const tpmProblems = hostTpmProblems(host);
  const hostStale = hostStatusStale(host);
  return (
    <>
      <PageHeader eyebrow="Backupserver" title="Übersicht" />
      {rebootDays !== null && (
        <Card aria-label="Neustart nötig" className="mb-4">
          <CardHeader title="Neustart nötig – Passphrase erforderlich" />
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={rebootDays >= HOST_REBOOT_RED_DAYS ? "danger" : "warn"}>
              {rebootDays >= HOST_REBOOT_RED_DAYS ? `seit ${rebootDays} Tagen überfällig` : rebootDays > 0 ? `seit ${rebootDays} ${rebootDays === 1 ? "Tag" : "Tagen"}` : "seit heute"}
            </Badge>
            <span>
              Debian-Sicherheitsupdates werden erst nach einem Neustart wirksam. Die Platte wird beim Start per Passphrase entsperrt – deshalb
              startet dieser Server nicht von selbst neu. Zu einer Zeit ohne Sicherung neu starten (<code>sudo systemctl reboot</code>) und die
              Passphrase an der Konsole eingeben.
            </span>
          </p>
        </Card>
      )}
      {tpmProblems.length > 0 && (
        <Card aria-label="TPM-Bindung" className="mb-4">
          <CardHeader title="TPM-Bindung der Platte unvollständig" />
          <ul className="list-disc pl-5 text-sm">
            {tpmProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Card>
      )}
      {hostStale && (
        <p role="alert" className="mb-4 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          Host-Status veraltet – der Timer <code>schulos-hoststatus.timer</code> meldet sich nicht; Neustart- und TPM-Hinweise fehlen bis dahin.
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState title="Noch keine Instanz gekoppelt">
          Unter <Link href="/instanzen" className="underline">Instanzen</Link> einen Kopplungscode erzeugen und im Hauptsystem eingeben.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((i, n) => {
            const s = status[n]!;
            return (
              <Card key={i.id} aria-label={i.name}>
                <CardHeader title={<Link href={`/instanzen/${i.id}`} className="hover:underline">{i.name}</Link>} />
                <Badge tone={TONE[s.health]}>{HEALTH_LABEL[s.health]}</Badge>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Letzte Sicherung</dt>
                  <dd>{s.lastOkAt ? fmt.format(s.lastOkAt) : "–"}</dd>
                  {s.lastRun?.status === "ok" && s.lastRun.bytesTotal !== null && (
                    <>
                      <dt className="text-muted">Größe</dt>
                      <dd>
                        {formatBytes(s.lastRun.bytesTotal)} (neu: {formatBytes(s.lastRun.bytesAdded ?? 0)})
                      </dd>
                    </>
                  )}
                  {s.lastRun?.status === "failed" && (
                    <>
                      <dt className="text-muted">Fehler</dt>
                      <dd className="text-danger">{s.lastRun.error ?? "unbekannt"}</dd>
                    </>
                  )}
                  <dt className="text-muted">Test-Restore</dt>
                  <dd className={tests[n]?.status === "failed" ? "text-danger" : undefined}>
                    {tests[n] ? `${tests[n]!.status === "ok" ? "ok" : "fehlgeschlagen"} am ${fmt.format(tests[n]!.startedAt)}` : "noch keiner"}
                  </dd>
                  <dt className="text-muted">Offsite</dt>
                  <dd className={copies[n]?.status === "failed" ? "text-danger" : offsite ? undefined : "text-muted"}>
                    {!offsite
                      ? "nicht eingerichtet"
                      : copies[n]
                        ? `${copies[n]!.status === "ok" ? `Stand ${String((copies[n]!.details as { stand?: string } | null)?.stand ?? "?")}` : "fehlgeschlagen"} am ${fmt.format(copies[n]!.startedAt)}`
                        : "noch keine Kopie"}
                  </dd>
                  <dt className="text-muted">Zeitplan</dt>
                  <dd>täglich {i.schedule.join(", ")} Uhr</dd>
                </dl>
              </Card>
            );
          })}
        </div>
      )}
      <Card aria-label="E-Mail-Benachrichtigung" className="mt-6">
        <CardHeader title="E-Mail-Benachrichtigung" />
        {mailError ? (
          <p role="alert" className="text-sm whitespace-pre-line text-danger">
            {mailError}
          </p>
        ) : mail ? (
          <>
            <p className="text-sm">
              Alarme (Backup überfällig oder fehlgeschlagen, Prüfung/Test-Restore/Offsite fehlgeschlagen, Speicherplatz knapp) gehen an{" "}
              <strong>{mail.to.join(", ")}</strong>.
            </p>
            <TestMailForm />
          </>
        ) : (
          <p className="text-sm text-muted">
            Nicht eingerichtet – in <code>backup.env</code>: <code>SCHULOS_SMTP_HOST</code>, <code>SCHULOS_SMTP_FROM</code>, <code>SCHULOS_ALARM_TO</code>.
          </p>
        )}
      </Card>
    </>
  );
}
