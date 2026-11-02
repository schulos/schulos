import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { canConfigure } from "@/modules/gebaeude/inventar";
import { LOAN_STATE_LABELS } from "@/modules/gebaeude/labels";
import { canLendAny, formatLoanDay, listOpenLoans, type LoanRow } from "@/modules/gebaeude/leihe";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Leihgeräte" };

function LoanItem({ l }: { l: LoanRow }) {
  return (
    <Link
      href={`/gebaeude/inventar/${encodeURIComponent(l.assetId)}#leihe`}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 hover:ring-1 hover:ring-border-strong"
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{l.assetName}</span>
        {l.inventoryNo && <span className="font-mono text-xs text-muted">{l.inventoryNo}</span>}
        {l.state === "ueberfaellig" && <Badge tone="danger">{LOAN_STATE_LABELS.ueberfaellig}</Badge>}
      </span>
      <span className="text-sm">
        {l.borrower ? `${l.borrower}${l.className ? ` (${l.className})` : ""}` : "gelöschtes Konto"}
      </span>
      <span className="text-xs text-muted">
        {l.categoryName} · seit {formatLoanDay(l.loanedOn)} · Rückgabe bis {formatLoanDay(l.dueOn)}
        {l.overdueLevel > 0 && ` · ${l.overdueLevel}. Erinnerung verschickt`}
      </span>
    </Link>
  );
}

/**
 * INV-05: offene Ausleihen (Leihgeräte) für alle, die verleihen dürfen – nur die eigenen Kategorien, überfällige zuerst. Verliehen wird
 * auf der Geräteseite (Etikett scannen oder aus dem Inventar öffnen).
 */
export default async function LeihenPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await canLendAny(db, perms))) notFound();
  const today = toBerlinDate(new Date());
  const loans = await listOpenLoans(db, perms, today);
  const overdue = loans.filter((l) => l.state === "ueberfaellig");
  const open = loans.filter((l) => l.state !== "ueberfaellig");

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Leihgeräte" />
      <GebaeudeNav current="inventar" configure={canConfigure(perms)} />
      <p className="text-sm text-muted">
        Verliehen wird auf der Seite des Geräts: Etikett mit dem Handy scannen oder das Gerät im{" "}
        <Link href="/gebaeude/inventar" className="font-medium text-accent-ink hover:underline">
          Inventar
        </Link>{" "}
        öffnen. Zurückgegebene Ausleihen werden ein Jahr nach der Rückgabe gelöscht.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/gebaeude/leihen/meine">Meine Leihgeräte</Link>
        </Button>
      </div>
      {loans.length === 0 ? (
        <EmptyState title="Nichts verliehen">Zurzeit ist kein Gerät aus Ihren Kategorien verliehen.</EmptyState>
      ) : (
        <>
          {overdue.length > 0 && (
            <Card aria-labelledby="ueberfaellig">
              <CardHeader title={<span id="ueberfaellig">Überfällig ({overdue.length})</span>} />
              <ul aria-label="Überfällige Leihgeräte" className="flex flex-col gap-2">
                {overdue.map((l) => (
                  <li key={l.id}>
                    <LoanItem l={l} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {open.length > 0 && (
            <Card aria-labelledby="verliehen">
              <CardHeader title={<span id="verliehen">Verliehen ({open.length})</span>} />
              <ul aria-label="Verliehene Geräte" className="flex flex-col gap-2">
                {open.map((l) => (
                  <li key={l.id}>
                    <LoanItem l={l} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
