import type { Metadata } from "next";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { LOAN_STATE_LABELS } from "@/modules/gebaeude/labels";
import { formatLoanDay, myLoans, type LoanRow } from "@/modules/gebaeude/leihe";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Meine Leihgeräte" };

function LoanList({ loans, label }: { loans: LoanRow[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {loans.map((l) => (
        <li key={l.id} className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{l.assetName}</span>
            {l.inventoryNo && <span className="font-mono text-xs text-muted">{l.inventoryNo}</span>}
            <Badge tone={l.state === "ueberfaellig" ? "danger" : l.state === "zurueck" ? "neutral" : "soft"}>{LOAN_STATE_LABELS[l.state]}</Badge>
          </span>
          <span className="text-muted">
            ausgeliehen am {formatLoanDay(l.loanedOn)} · Rückgabe bis <strong className="text-ink">{formatLoanDay(l.dueOn)}</strong>
            {l.returnedAt && ` · zurückgegeben am ${formatLoanDay(toBerlinDate(l.returnedAt))}`}
          </span>
          {l.accessories && <span className="text-muted">Zubehör: {l.accessories}</span>}
          {l.returnNote && <span className="text-muted">Befund bei der Rückgabe: {l.returnNote}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * INV-05 „Meine Leihgeräte“: eigene Ausleihen (offene und zurückgegebene bis zum Löschlauf), bei Eltern zusätzlich die ihrer Kinder
 * (lesend; minderjährig bzw. mit Einwilligung „Eltern informieren“). Ziel der Erinnerungen; braucht kein Recht außer der Anmeldung.
 */
export default async function MeineLeihgeraetePage() {
  const { perms } = await requireUser();
  const data = await myLoans(await getDb(), perms, toBerlinDate(new Date()));
  const nothing = data.own.length === 0 && data.children.length === 0;
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Meine Leihgeräte" />
      {nothing ? (
        <EmptyState title="Keine Leihgeräte">Du hast zurzeit kein Gerät der Schule ausgeliehen.</EmptyState>
      ) : (
        <>
          {data.own.length > 0 && (
            <Card aria-labelledby="eigene">
              <CardHeader title={<span id="eigene">Ausgeliehen</span>} />
              <LoanList loans={data.own} label="Meine Leihgeräte" />
            </Card>
          )}
          {data.children.map((c) => (
            <Card key={c.id} aria-labelledby={`kind-${c.id}`}>
              <CardHeader title={<span id={`kind-${c.id}`}>{c.name}</span>} />
              <LoanList loans={c.loans} label={`Leihgeräte von ${c.name}`} />
            </Card>
          ))}
          <p className="text-xs text-muted">
            Zurückgegebene Geräte stehen hier noch ein Jahr nach der Rückgabe, danach werden die Angaben gelöscht. Fragen zur Rückgabe oder Verlängerung beantwortet die Stelle, die das Gerät
            ausgegeben hat.
          </p>
        </>
      )}
    </main>
  );
}
