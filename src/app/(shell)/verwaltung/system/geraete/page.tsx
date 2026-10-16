import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { X509Certificate } from "node:crypto";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { fingerprintOf, VALIDITY_DAYS } from "@/core/device-certs/issue";
import { effectivePolicy } from "@/core/device-certs/policy";
import { caConfigured, listDeviceCerts, readExternalSettings, REVOKE_REASONS, type DeviceCertStatus, type RevokeReason } from "@/core/device-certs/service";
import { caHealth, readRootPem, stepCaConfig } from "@/core/device-certs/step-ca";
import { externalZone } from "@/core/external-access";
import { hasPermission } from "@/core/permissions";
import { TZ } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ExternalSettingsForm, IssueForm, RevokeForm } from "./forms";

export const metadata: Metadata = { title: "Gerätezertifikate" };
export const dynamic = "force-dynamic";

const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const STATUS: Record<DeviceCertStatus, { tone: "success" | "warn" | "danger" | "neutral"; label: string }> = {
  gueltig: { tone: "success", label: "gültig" },
  "noch-nicht-gueltig": { tone: "neutral", label: "noch nicht gültig" },
  abgelaufen: { tone: "warn", label: "abgelaufen" },
  gesperrt: { tone: "danger", label: "gesperrt" },
};

/** Schul-CA: eingerichtet? erreichbar? Fingerabdruck der Wurzel (zum Abgleich im MDM) */
async function caState() {
  if (!caConfigured()) return { configured: false as const };
  const rootPem = readRootPem();
  let rootFingerprint: string | null = null;
  try {
    rootFingerprint = rootPem ? fingerprintOf(new X509Certificate(rootPem)) : null;
  } catch {
    rootFingerprint = null;
  }
  let error: string | null = null;
  let healthy = false;
  try {
    healthy = await caHealth(stepCaConfig());
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { configured: true as const, rootFingerprint, healthy, error };
}

export default async function GeraetePage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.system")) notFound();
  const db = await getDb();
  const [certs, settings, ca, zone] = await Promise.all([listDeviceCerts(db), readExternalSettings(db), caState(), headers().then(externalZone)]);
  const policy = effectivePolicy(settings, ca.configured);
  const intern = zone === "intern";

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung · System" title="Gerätezertifikate" />
      <p className="text-sm text-muted">
        Lehrkräfte und Personal erreichen SchulOS von außerhalb des Schulnetzes nur auf freigegebenen Geräten: Das Gerät weist sich mit
        einem Zertifikat der Schul-CA aus, das hier ausgestellt und gesperrt wird. Eltern und Schüler:innen melden sich wie bisher an,
        öffentliche Seiten brauchen nichts. Einrichtung: INSTALLATION.md „Gerätezertifikate“.{" "}
        <Link href="/verwaltung/system" className="text-accent-ink underline underline-offset-2">
          Zurück zu System
        </Link>
      </p>
      {!intern && (
        <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          Du bist gerade außerhalb des Schulnetzes – ausstellen, sperren und die Regeln ändern geht nur im Schulnetz.
        </p>
      )}

      <Card aria-label="Schul-CA">
        <CardHeader title="Schul-CA" />
        {!ca.configured ? (
          <p className="text-sm text-muted">
            Nicht eingerichtet. Auf dem Server: Passwörter in die <code>.env</code> (<code>SCHULOS_DEVICE_CA_PASSWORD</code>,{" "}
            <code>SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD</code>), <code>docker compose --profile geraete up -d</code>, dann{" "}
            <code>SCHULOS_DEVICE_CERTS=an</code> und <code>docker compose up -d</code>.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Status</dt>
            <dd>
              <Badge tone={ca.healthy ? "success" : "danger"}>{ca.healthy ? "erreichbar" : "nicht erreichbar"}</Badge>
              {ca.error && <span className="ml-2 text-danger">{ca.error}</span>}
            </dd>
            <dt className="text-muted">Wurzel (SHA-256)</dt>
            <dd className="font-mono text-xs break-all">{ca.rootFingerprint ?? "fehlt"}</dd>
          </dl>
        )}
      </Card>

      <Card aria-label="Regeln für den Zugriff von außen">
        <CardHeader title="Regeln für den Zugriff von außen" />
        <p className="text-sm">
          Zurzeit: Lehrkräfte/Personal von außen <strong>{policy.staffCertRequired ? "nur mit Gerätezertifikat" : "auch ohne Gerätezertifikat"}</strong>,
          Verwaltung/Admin von außen <strong>{policy.adminAllowed ? "erlaubt" : "gesperrt"}</strong>.
        </p>
        <ExternalSettingsForm staffCert={settings.staffCert} adminAllowed={settings.adminAllowed} caReady={ca.configured} />
      </Card>

      {ca.configured && intern && (
        <Card aria-label="Neues Gerätezertifikat">
          <CardHeader title="Neues Gerätezertifikat" />
          <p className="text-sm text-muted">
            SchulOS erzeugt Schlüssel und Zertifikat und gibt beides einmal als Datei mit Passwort aus. iPad/Mac: <code>.mobileconfig</code>{" "}
            öffnen bzw. im Apple-MDM als Profil hochladen. Intune: <code>.p12</code> als „PKCS importiertes Zertifikat“ bzw. für Windows
            als Benutzer-/Gerätezertifikat verteilen. Relution: <code>.p12</code> als Zertifikats-Konfiguration mit Passwort.
            Automatische Ausstellung durch das MDM (SCEP/ACME) folgt später.
          </p>
          <IssueForm defaultDays={VALIDITY_DAYS.default} minDays={VALIDITY_DAYS.min} maxDays={VALIDITY_DAYS.max} />
        </Card>
      )}

      <section aria-label="Ausgestellte Zertifikate" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Ausgestellte Zertifikate</h2>
        {certs.length === 0 ? (
          <EmptyState title="Noch keine Gerätezertifikate" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Gerät</th>
                <th>Name im Zertifikat</th>
                <th>Nur für</th>
                <th>Gültig bis</th>
                <th>Status</th>
                <th>Fingerabdruck</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.label}</td>
                  <td className="font-mono text-xs">{c.commonName}</td>
                  <td>{c.user ? `${c.user.name}${c.user.username ? ` (${c.user.username})` : ""}` : "alle Konten"}</td>
                  <td className="whitespace-nowrap">{day.format(c.notAfter)}</td>
                  <td>
                    <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    {c.revokedAt && (
                      <span className="block text-xs text-muted">
                        {day.format(c.revokedAt)}
                        {c.revokeReason ? ` · ${REVOKE_REASONS[c.revokeReason as RevokeReason] ?? c.revokeReason}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="font-mono text-xs" title={c.fingerprint}>
                    {c.fingerprint.slice(0, 16)}…
                  </td>
                  <td>{!c.revokedAt && intern && <RevokeForm id={c.id} label={c.label} />}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
