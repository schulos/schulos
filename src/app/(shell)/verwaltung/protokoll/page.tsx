import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { ACTION_FILTERS, AUDIT_PAGE_SIZE, listAudit } from "@/modules/verwaltung/audit-view";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Pagination, Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Protokoll" };

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export default async function ProtokollPage({ searchParams }: { searchParams: Promise<{ bereich?: string; page?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.rights")) notFound();
  const sp = await searchParams;
  const prefix = ACTION_FILTERS.find((f) => f.value === sp.bereich)?.value;
  const page = Math.max(1, Number(sp.page) || 1);
  const { rows, total } = await listAudit(await getDb(), { prefix, page });

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Protokoll" />
      <p className="max-w-3xl text-sm text-muted">
        Änderungen in der Verwaltung und Lesezugriffe auf Klassenbuch, Fehlzeiten und Abwesenheiten (wiederholtes Blättern
        zählt innerhalb von 30 Minuten einmal). Einträge älter als ein Jahr und Einträge gelöschter Konten werden vom
        Löschlauf pseudonymisiert: Statt des Namens steht dann ein Pseudonym, das für dieselbe Person immer gleich ist.
      </p>
      <form className="flex flex-wrap items-end gap-3">
        <Select name="bereich" defaultValue={prefix ?? ""} aria-label="Bereich" className="w-56">
          <option value="">Alle Bereiche</option>
          {ACTION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Button type="submit">Filtern</Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="Noch keine Einträge">Änderungen in der Verwaltung erscheinen hier.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Wer</th>
              <th>Was</th>
              <th>Betrifft</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-muted tabular-nums">{fmt.format(r.at)}</td>
                <td>{r.actor}</td>
                <td className="font-medium">{r.label}</td>
                <td>{r.target}</td>
                <td className="text-muted">{r.detail && <code className="text-xs">{r.detail}</code>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination page={page} total={total} pageSize={AUDIT_PAGE_SIZE} basePath="/verwaltung/protokoll" params={{ bereich: prefix }} />
    </main>
  );
}
