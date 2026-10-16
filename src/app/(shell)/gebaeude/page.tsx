import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { CATEGORY_LABELS, OPEN_STATUSES, PRIORITY_LABELS, STATUS_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketCategory, type TicketPriority } from "@/modules/gebaeude/labels";
import { buildings, canReport, canUse, canViewAll, listTickets, type TicketRow } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { canConfigure } from "@/modules/gebaeude/pruefungen";
import { GebaeudeNav, TicketItem } from "./ui";

export const metadata: Metadata = { title: "Gebäude & Technik" };

type Search = { kategorie?: string; prioritaet?: string; gebaeude?: string; ansicht?: string };

function TicketList({ items, label, showReporter, showStatus = true }: { items: TicketRow[]; label: string; showReporter?: boolean; showStatus?: boolean }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {items.map((t) => (
        <li key={t.id}>
          <TicketItem t={t} showReporter={showReporter} showStatus={showStatus} />
        </li>
      ))}
    </ul>
  );
}

/** Board (Hausmeisterei/Verwaltung): Spalten nach Status, Filter; Melder:innen sehen ihre eigenen Meldungen. */
export default async function GebaeudePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canUse(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const report = canReport(perms);
  const meldenButton = report ? (
    <Button asChild variant="primary">
      <Link href="/gebaeude/melden">Mangel melden</Link>
    </Button>
  ) : null;

  if (!canViewAll(perms) || sp.ansicht === "meine") {
    const [open, closed] = await Promise.all([listTickets(db, perms, { mine: true }), listTickets(db, perms, { mine: true, state: "closed", limit: 20 })]);
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Gebäude & Technik" title="Meine Meldungen" actions={meldenButton} />
        {canViewAll(perms) && (
          <Link href="/gebaeude" className="text-sm font-medium text-accent-ink hover:underline">
            Zur Übersicht aller Meldungen
          </Link>
        )}
        {!canViewAll(perms) && canConfigure(perms) && (
          <p className="flex flex-wrap gap-4 text-sm">
            <Link href="/gebaeude/pruefarten" className="font-medium text-accent-ink hover:underline">
              Prüfarten und Zuständigkeiten
            </Link>
            <Link href="/gebaeude/anlagen" className="font-medium text-accent-ink hover:underline">
              Anlagen und Geräte
            </Link>
          </p>
        )}
        <section aria-labelledby="offen" className="flex flex-col gap-3">
          <h2 id="offen" className="font-display text-xl font-bold">
            Offen {open.length > 0 && <Badge tone="count">{open.length}</Badge>}
          </h2>
          {open.length === 0 ? <EmptyState title="Keine offenen Meldungen">Etwas kaputt? Über „Mangel melden“ erreicht es die Hausmeisterei.</EmptyState> : <TicketList items={open} label="Offene Meldungen" />}
        </section>
        {closed.length > 0 && (
          <section aria-labelledby="erledigt" className="flex flex-col gap-3">
            <h2 id="erledigt" className="font-display text-xl font-bold">
              Abgeschlossen
            </h2>
            <TicketList items={closed} label="Abgeschlossene Meldungen" />
          </section>
        )}
      </main>
    );
  }

  const category = TICKET_CATEGORIES.find((c): c is TicketCategory => c === sp.kategorie);
  const priority = TICKET_PRIORITIES.find((p): p is TicketPriority => p === sp.prioritaet);
  const allBuildings = await buildings(db);
  const building = allBuildings.find((b) => b === sp.gebaeude);
  const filter = { category, priority, building };
  const [open, recent] = await Promise.all([
    listTickets(db, perms, filter),
    listTickets(db, perms, { ...filter, state: "closed", closedWithinDays: 14, limit: 30 }),
  ]);
  const byStatus = (s: string) => open.filter((t) => t.status === s);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Meldungen"
        actions={
          <>
            {report && (
              <Button asChild>
                <Link href="/gebaeude?ansicht=meine">Meine Meldungen</Link>
              </Button>
            )}
            {meldenButton}
          </>
        }
      />
      <GebaeudeNav current="meldungen" configure={canConfigure(perms)} />
      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
        <Field label="Kategorie">
          <Select name="kategorie" defaultValue={category ?? ""} className="w-44">
            <option value="">alle</option>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priorität">
          <Select name="prioritaet" defaultValue={priority ?? ""} className="w-40">
            <option value="">alle</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {allBuildings.length > 0 && (
          <Field label="Gebäude">
            <Select name="gebaeude" defaultValue={building ?? ""} className="w-48">
              <option value="">alle</option>
              {allBuildings.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
        )}
        <Button type="submit">Filtern</Button>
        {(category || priority || building) && (
          <Link href="/gebaeude" className="flex h-11 items-center text-sm font-medium text-accent-ink hover:underline">
            Filter aufheben
          </Link>
        )}
      </form>

      {open.length === 0 && recent.length === 0 ? (
        <EmptyState title="Keine Meldungen">Gerade ist nichts offen.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {OPEN_STATUSES.map((s) => {
            const items = byStatus(s);
            return (
              <section key={s} aria-labelledby={`spalte-${s}`} className="flex flex-col gap-2 rounded-card bg-surface-2 p-3">
                <h2 id={`spalte-${s}`} className="flex items-center justify-between gap-2 text-sm font-semibold">
                  {STATUS_LABELS[s]} <Badge tone="count">{items.length}</Badge>
                </h2>
                {items.length === 0 ? <p className="px-1 text-sm text-muted">–</p> : <TicketList items={items} label={STATUS_LABELS[s]} showReporter showStatus={false} />}
              </section>
            );
          })}
        </div>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="zuletzt" className="flex flex-col gap-3">
          <h2 id="zuletzt" className="font-display text-xl font-bold">
            Abgeschlossen (letzte 14 Tage)
          </h2>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {recent.map((t) => (
              <TicketItem key={t.id} t={t} showReporter />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
