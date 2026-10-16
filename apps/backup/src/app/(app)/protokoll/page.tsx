import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { auditLabel, recentAudit } from "@/audit";
import { getDb } from "@/db/client";

export const metadata: Metadata = { title: "Protokoll" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export default async function ProtokollPage() {
  const rows = await recentAudit(await getDb());
  return (
    <>
      <PageHeader eyebrow="Backupserver" title="Protokoll" />
      <p className="text-sm text-muted">Anmeldungen, Konfigurationsänderungen und Wiederherstellungen – die letzten 200 Einträge.</p>
      {rows.length === 0 ? (
        <EmptyState title="Noch keine Einträge" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Vorgang</th>
              <th>Durch</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{fmt.format(r.createdAt)}</td>
                <td>{auditLabel(r.action)}</td>
                <td>{r.actor ?? "System"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
