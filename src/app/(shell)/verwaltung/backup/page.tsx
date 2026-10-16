import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { HEALTH_LABEL, RESTORE_SCOPE_LABEL, type BackupHealth } from "@schulos/server/agent-api";
import { pairingView, readPairing } from "@/core/backup/pairing";
import { backupStatus } from "@/core/backup/status";
import { hasPermission } from "@/core/permissions";
import { getSchoolSettings } from "@/core/settings";
import { TZ } from "@/core/time";
import { confirmRecoveryAction, unpairAction } from "@/modules/verwaltung/backup-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { PrintButton } from "@schulos/ui/print-button";
import { PairForm, RestoreDecisionForm, RunNowForm, UnpairForm } from "./forms";

export const metadata: Metadata = { title: "Backup" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const HEALTH_TONE: Record<BackupHealth, "success" | "warn" | "danger"> = { ok: "success", overdue: "danger", failed: "danger", none: "warn" };

export default async function BackupPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.system")) notFound();
  const view = pairingView(readPairing());
  const status = backupStatus();
  const school = await getSchoolSettings();

  if (!view)
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Verwaltung" title="Backup" />
        <p role="alert" className="rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          <strong>Keine Sicherung eingerichtet.</strong> Ohne gekoppelten Backupserver gehen bei einem Plattenschaden alle Daten verloren.
        </p>
        <Card aria-label="Koppeln">
          <CardHeader title="Backupserver koppeln" />
          <p className="mb-4 text-sm text-muted">
            Der Backupserver steuert Zeitplan, Aufbewahrung und Prüfungen. SchulOS darf Sicherungen nur hinzufügen, nie löschen – auch ein
            übernommenes Hauptsystem kann die Backups nicht vernichten.
          </p>
          <PairForm defaultName={school.name} />
        </Card>
      </main>
    );

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Backup" />

      {view.recoveryKeyToConfirm && (
        <Card aria-label="Wiederherstellungsschlüssel ausdrucken" className="border-warn">
          <CardHeader title="Wiederherstellungsschlüssel – jetzt ausdrucken" />
          <p className="text-sm">
            Mit diesem Schlüssel lassen sich die Sicherungen auch dann entschlüsseln, wenn Hauptsystem <em>und</em> Backupserver verloren sind
            (z. B. aus der Offsite-Kopie). Ausdrucken und sicher verwahren, z. B. im Tresor der Schulleitung. SchulOS zeigt ihn nach der
            Bestätigung nie wieder an.
          </p>
          <output aria-label="Wiederherstellungsschlüssel" className="my-4 block w-fit rounded-xl bg-surface-2 px-4 py-3 font-mono text-xl tracking-wider">
            {view.recoveryKeyToConfirm}
          </output>
          <form action={confirmRecoveryAction} className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="verwahrt" value="1" required className="size-4" />
              Ausgedruckt und sicher verwahrt
            </label>
            <Button type="submit" variant="primary" size="sm">
              Bestätigen
            </Button>
            <PrintButton label="Drucken" />
          </form>
        </Card>
      )}

      {status.restoreRequest && (
        <Card aria-label="Wiederherstellung angefordert" className="border-danger">
          <CardHeader title="Wiederherstellung angefordert" />
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Stand</dt>
            <dd>
              {fmt.format(new Date(status.restoreRequest.snapshotTime))} ({status.restoreRequest.snapshotShort})
            </dd>
            <dt className="text-muted">Umfang</dt>
            <dd>{RESTORE_SCOPE_LABEL[status.restoreRequest.scope]}</dd>
            <dt className="text-muted">Angefordert von</dt>
            <dd>
              {status.restoreRequest.requestedBy ?? "unbekannt"} auf dem Backupserver, {fmt.format(new Date(status.restoreRequest.createdAt))}
            </dd>
          </dl>
          {status.restoreRequest.status === "bestaetigt" ? (
            <p role="status" className="text-sm">
              Bestätigt – der Backup-Agent beginnt innerhalb einer Minute.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm">
                Nichts wird zurückgespielt, bevor hier der Code eingegeben ist, der auf dem Backupserver beim Auftrag steht.
                {status.restoreRequest.scope === "komplett" &&
                  " Bei „komplett“ ist SchulOS für einige Minuten im Wartungsmodus; alles seit dem Stand Eingegebene geht verloren (der aktuelle Stand wird vorher gesichert)."}
              </p>
              <RestoreDecisionForm id={status.restoreRequest.id} />
            </>
          )}
        </Card>
      )}

      <Card aria-label="Sicherungsstand">
        <CardHeader title="Sicherung" />
        <div className="mb-3">
          <Badge tone={HEALTH_TONE[status.health]}>{HEALTH_LABEL[status.health]}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Letzte Sicherung</dt>
          <dd>{status.lastOkAt ? fmt.format(status.lastOkAt) : "noch keine"}</dd>
          {status.lastRun?.status === "failed" && (
            <>
              <dt className="text-muted">Letzter Lauf</dt>
              <dd className="text-danger">
                fehlgeschlagen am {fmt.format(new Date(status.lastRun.finishedAt))}: {status.lastRun.error ?? "unbekannter Fehler"}
              </dd>
            </>
          )}
          {status.runningSince && (
            <>
              <dt className="text-muted">Gerade</dt>
              <dd>Sicherung läuft seit {fmt.format(status.runningSince)}</dd>
            </>
          )}
          {status.lastRestore && (
            <>
              <dt className="text-muted">Letzte Wiederherstellung</dt>
              <dd className={status.lastRestore.status === "fehlgeschlagen" ? "text-danger" : undefined}>
                {status.lastRestore.status === "fertig" ? "abgeschlossen" : "fehlgeschlagen"} am {fmt.format(new Date(status.lastRestore.finishedAt))}, Stand{" "}
                {status.lastRestore.snapshotShort} ({status.lastRestore.scope}){status.lastRestore.error ? `: ${status.lastRestore.error}` : ""}
              </dd>
            </>
          )}
          <dt className="text-muted">Backup-Agent</dt>
          <dd>
            {status.contactError
              ? `erreicht den Backupserver nicht: ${status.contactError}`
              : status.lastContactAt
                ? `zuletzt verbunden ${fmt.format(status.lastContactAt)}`
                : "hat sich noch nicht gemeldet (läuft der Container backup-agent?)"}
          </dd>
        </dl>
        <p className="mt-3 text-sm text-muted">Zeitplan und Aufbewahrung stellt der Backupserver ein.</p>
        <div className="mt-3">
          <RunNowForm />
        </div>
      </Card>

      <Card aria-label="Kopplung">
        <CardHeader title="Backupserver" />
        <div className="mb-3">
          <Badge tone="success">gekoppelt</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Server</dt>
          <dd>
            {view.serverName} · {view.backupUrl}
          </dd>
          <dt className="text-muted">Name dieser Instanz</dt>
          <dd>{view.instanceName}</dd>
          <dt className="text-muted">Gekoppelt</dt>
          <dd>{fmt.format(new Date(view.pairedAt))}</dd>
          <dt className="text-muted">Zertifikat</dt>
          <dd>
            {view.insecure ? (
              "unverschlüsselt (http – nur Entwicklung)"
            ) : view.caFingerprint ? (
              <>
                eigene Zertifizierungsstelle, gepinnt (SHA-256 <span className="font-mono break-all">{view.caFingerprint}</span>)
              </>
            ) : (
              "öffentliche Zertifizierungsstelle"
            )}
          </dd>
        </dl>
        <div className="mt-4">
          <UnpairForm action={unpairAction} />
        </div>
      </Card>
    </main>
  );
}
