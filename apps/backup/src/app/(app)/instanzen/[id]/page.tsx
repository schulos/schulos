import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { HEALTH_LABEL } from "@schulos/server/agent-api";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { instanceStatus } from "@/agent/service";
import { appSecret } from "@/auth/auth";
import { getDb } from "@/db/client";
import { instances } from "@/db/schema";
import { formatBytes } from "@/lib/format";
import { maintenancePlan, recentMaintenance } from "@/maintenance/service";
import { repoPassword } from "@/pairing/service";
import { listSnapshots, localRestic, type SnapshotInfo } from "@/restic/local";
import { cancelRestoreAction, checkNowAction, offsiteNowAction, pruneNowAction, restoreTestNowAction } from "./actions";
import { offsiteConfig } from "@/maintenance/offsite";
import { ReplacementCodeForm, RestoreForm, RetentionForm, ScheduleForm } from "./forms";
import { listRestoreJobs } from "@/restore/service";

export const metadata: Metadata = { title: "Instanz" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
const RESTORE_STATUS: Record<string, string> = {
  wartet: "wartet auf Bestätigung im Hauptsystem",
  bestaetigt: "bestätigt – der Agent beginnt gleich",
  laeuft: "läuft",
  fertig: "fertig",
  fehlgeschlagen: "fehlgeschlagen",
  abgelehnt: "abgelehnt",
};
const KIND: Record<string, string> = { prune: "Aufräumen", check: "Prüfung", restore_test: "Test-Restore", offsite: "Offsite-Kopie", immutable: "Unveränderliche Kopie" };

/** Kennzahlen eines Wartungslaufs in einer Zeile. */
function maintenanceSummary(kind: string, d: Record<string, unknown> | null): string {
  if (!d) return "ok";
  if (kind === "prune") return `${String(d.entfernt ?? 0)} entfernt, ${String(d.behalten ?? 0)} behalten`;
  if (kind === "check") return `ok (Stichprobe ${String(d.stichprobe ?? "")})`;
  if (kind === "immutable") return `Schnappschuss ${String(d.schnappschuss ?? "?")} (${String(d.alterStunden ?? "?")} h alt)`;
  if (kind === "offsite") return `ok – Stand ${String(d.stand ?? "?")}, ${String(d.kopiert ?? 0)} neu kopiert, ${String(d.staende ?? 0)} Stände offsite, ${String(d.entfernt ?? 0)} entfernt`;
  if (kind === "restore_test")
    return [
      `ok – Stand ${String(d.stand ?? "?")}`,
      typeof d.dumpBytes === "number" ? `Dump ${formatBytes(d.dumpBytes)}` : null,
      d.tabellen !== null && d.tabellen !== undefined ? `${String(d.tabellen)} Tabellen, ${String(d.migrationen)} Migrationen, ${String(d.konten)} Konten` : "ohne Test-Datenbank: nur Lesbarkeit geprüft",
    ]
      .filter(Boolean)
      .join(" · ");
  return "ok";
}

export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const [inst] = await db.select().from(instances).where(and(eq(instances.id, id), isNull(instances.removedAt)));
  if (!inst) notFound();
  const [status, runs, restores] = await Promise.all([instanceStatus(db, inst.id), recentMaintenance(db, inst.id), listRestoreJobs(db, inst.id)]);
  const plan = maintenancePlan();
  const offsite = offsiteConfig();
  let snapshots: SnapshotInfo[] = [];
  let snapError: string | null = null;
  try {
    snapshots = await listSnapshots(localRestic(), inst.restUser, repoPassword(inst, appSecret()));
  } catch (err) {
    snapError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <PageHeader eyebrow="Instanz" title={inst.name} />
      <p className="text-sm">
        <Link href="/instanzen" className="text-muted hover:underline">
          ← alle Instanzen
        </Link>
        <span className="ml-3">
          <Badge tone={status.health === "ok" ? "success" : status.health === "none" ? "warn" : "danger"}>{HEALTH_LABEL[status.health]}</Badge>
        </span>
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-label="Zeitplan">
          <CardHeader title="Zeitplan" />
          <ScheduleForm id={inst.id} schedule={inst.schedule} />
        </Card>
        <Card aria-label="Aufbewahrung">
          <CardHeader title="Aufbewahrung" />
          <RetentionForm id={inst.id} retention={inst.retention} reason={inst.retentionReason} />
        </Card>
      </div>

      <Card aria-label="Sicherungsstände">
        <CardHeader title={`Sicherungsstände (${snapshots.length})`} />
        {snapError ? (
          <p role="alert" className="text-sm text-danger">
            {snapError}
          </p>
        ) : snapshots.length === 0 ? (
          <EmptyState title="Noch keine Sicherung">Der Backup-Agent des Hauptsystems legt die erste beim nächsten Termin an.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Zeitpunkt</th>
                <th>Größe</th>
                <th>Kennung</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{fmt.format(s.time)}</td>
                  <td>{s.bytes === null ? "–" : formatBytes(s.bytes)}</td>
                  <td className="font-mono">{s.shortId}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card aria-label="Auf Hauptsystem wiederherstellen">
        <CardHeader title="Auf Hauptsystem wiederherstellen" />
        <p className="mb-4 text-sm text-muted">
          Der Auftrag läuft erst, wenn jemand im Hauptsystem den Code bestätigt. Bei „komplett“ sichert der Agent vorher den aktuellen
          Stand, schaltet SchulOS in den Wartungsmodus und startet es danach neu.
        </p>
        {snapshots.length > 0 ? (
          <RestoreForm
            id={inst.id}
            snapshots={snapshots.map((s) => ({ id: s.id, shortId: s.shortId, time: s.time.toISOString(), label: `${fmt.format(s.time)} (${s.shortId})` }))}
          />
        ) : (
          <p className="text-sm">Noch kein Stand vorhanden.</p>
        )}
        {restores.length > 0 && (
          <div className="mt-5">
            <Table>
              <thead>
                <tr>
                  <th>Angefordert</th>
                  <th>Stand</th>
                  <th>Umfang</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {restores.map((j) => (
                  <tr key={j.id}>
                    <td>{fmt.format(j.createdAt)}</td>
                    <td className="font-mono">{j.snapshotShort}</td>
                    <td>{j.scope}</td>
                    <td className={j.status === "fehlgeschlagen" ? "text-danger" : undefined}>
                      {RESTORE_STATUS[j.status] ?? j.status}
                      {j.error ? ` – ${j.error}` : ""}
                    </td>
                    <td>
                      {(j.status === "wartet" || j.status === "bestaetigt") && (
                        <form action={cancelRestoreAction}>
                          <input type="hidden" name="id" value={inst.id} />
                          <input type="hidden" name="job" value={j.id} />
                          <Button type="submit" size="sm" variant="ghost">
                            Abbrechen
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card aria-label="Neue Hardware">
        <CardHeader title="Hauptsystem auf neuer Hardware" />
        <p className="mb-3 text-sm text-muted">
          Ist das Hauptsystem defekt: neue Hardware mit der SchulOS-ISO installieren, „aus Backup wiederherstellen“ wählen, die Adresse dieses
          Servers und einen Ersatz-Kopplungscode eingeben. Das neue System übernimmt diese Instanz samt aller Sicherungen.
        </p>
        <ReplacementCodeForm id={inst.id} />
      </Card>

      <Card aria-label="Wartung">
        <CardHeader title="Wartung" />
        <p className="mb-3 text-sm text-muted">
          Aufräumen nach der Aufbewahrung täglich um {plan.prune.at} Uhr (nur hier wird gelöscht – das Hauptsystem darf das nicht), Prüfung mit
          Datenstichprobe wöchentlich um {plan.check.at} Uhr, Test-Restore der Datenbank monatlich um {plan.restore_test.at} Uhr.
          {offsite
            ? ` Offsite-Kopie täglich um ${plan.offsite.at} Uhr nach ${offsite.base} (gleiche Aufbewahrung, mit dem Wiederherstellungsschlüssel lesbar).`
            : " Keine Offsite-Kopie eingerichtet (SCHULOS_OFFSITE in backup.env)."}
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            { action: pruneNowAction, label: "Jetzt aufräumen" },
            { action: checkNowAction, label: "Jetzt prüfen" },
            { action: restoreTestNowAction, label: "Test-Restore jetzt" },
            ...(offsite ? [{ action: offsiteNowAction, label: "Offsite jetzt" }] : []),
          ].map((b) => (
            <form key={b.label} action={b.action}>
              <input type="hidden" name="id" value={inst.id} />
              <Button type="submit" size="sm" variant="secondary">
                {b.label}
              </Button>
            </form>
          ))}
        </div>
        {runs.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Zeitpunkt</th>
                <th>Art</th>
                <th>Ergebnis</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmt.format(r.startedAt)}</td>
                  <td>
                    {KIND[r.kind] ?? r.kind}
                    {r.triggeredBy ? " (von Hand)" : ""}
                  </td>
                  <td className={r.status === "failed" ? "text-danger" : undefined}>
                    {r.status === "failed"
                      ? (r.error ?? "fehlgeschlagen")
                      : maintenanceSummary(r.kind, r.details)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {status.lastRun && (
        <p className="text-xs text-muted">
          Letzte Meldung des Agenten: {fmt.format(status.lastRun.finishedAt)} ({status.lastRun.status === "ok" ? "ok" : "Fehler"}
          {status.lastRun.bytesTotal !== null ? `, ${formatBytes(status.lastRun.bytesTotal)}` : ""})
        </p>
      )}
    </>
  );
}
