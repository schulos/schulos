import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { mailAvailable } from "@/core/mail";
import { readImpressum } from "@/core/school/impressum";
import { canAuskunft } from "@/modules/anmeldung/auskunft";
import { VERFAHREN_KIND_LABELS } from "@/modules/anmeldung/labels";
import { canManage, canView, listVerfahren } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { dateTime, VerfahrenBadge } from "./shared";

export const metadata: Metadata = { title: "Schulanmeldung" };
export const dynamic = "force-dynamic";

/** Verwaltung → Schulanmeldung: Verfahren (P4-33). */
export default async function AnmeldungListePage() {
  const { perms } = await requireUser();
  if (!canView(perms)) notFound();
  const db = await getDb();
  const [rows, impressum] = await Promise.all([listVerfahren(db, perms), readImpressum(db)]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Verwaltung"
        title="Schulanmeldung"
        actions={
          canManage(perms) || canAuskunft(perms) ? (
            <span className="flex flex-wrap gap-2">
              {canAuskunft(perms) && (
                <Button asChild>
                  <Link href="/verwaltung/anmeldung/auskunft">Auskunft</Link>
                </Button>
              )}
              {canManage(perms) && (
                <Button asChild variant="primary">
                  <Link href="/verwaltung/anmeldung/neu">Neues Verfahren</Link>
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
      <p className="max-w-3xl text-sm text-muted">
        Eltern melden ihr Kind online vor und wählen einen Gesprächstermin. Verbindlich wird die Anmeldung im Gespräch, wenn die Unterlagen im Original
        vorliegen; über die Aufnahme entscheidet die Schulleitung.
      </p>
      {!mailAvailable() && (
        <p role="note" className="max-w-3xl rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          Der E-Mail-Versand ist nicht eingerichtet – Eltern bekommen keine Bestätigungslinks. Erst SMTP einrichten (Verwaltung → System).
        </p>
      )}
      {canManage(perms) && !impressum.complete && (
        <p role="note" data-testid="anmeldung-impressum-hinweis" className="max-w-3xl rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          Das Impressum ist unvollständig (fehlt: {impressum.missing.join(", ")}) – ohne vollständiges Impressum lässt sich kein Verfahren veröffentlichen.{" "}
          <Link href="/verwaltung/schule#impressum" className="underline underline-offset-2">
            Impressum ergänzen
          </Link>
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Noch kein Anmeldeverfahren" />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th>Verfahren</th>
                <th>Art</th>
                <th>Zeitraum</th>
                <th>Status</th>
                <th className="text-right">Anträge</th>
                <th className="text-right">Termine</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const confirmed = Object.entries(v.counts)
                  .filter(([s]) => s !== "unbestaetigt")
                  .reduce((n, [, c]) => n + (c ?? 0), 0);
                return (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/verwaltung/anmeldung/${v.id}`} className="font-medium text-accent-ink underline-offset-2 hover:underline">
                        {v.name}
                      </Link>
                      <span className="block text-xs text-muted">Schuljahr {v.schoolYearName}</span>
                    </td>
                    <td className="text-sm">{VERFAHREN_KIND_LABELS[v.kind]}</td>
                    <td className="text-sm whitespace-nowrap">
                      {dateTime.format(v.opensAt)} – {dateTime.format(v.closesAt)}
                    </td>
                    <td>
                      <VerfahrenBadge status={v.status} />
                    </td>
                    <td className="text-right tabular-nums">{confirmed}</td>
                    <td className="text-right tabular-nums">{v.slotCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </main>
  );
}
