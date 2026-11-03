import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import { canSeeCounts, MAX_MENUS, MEAL_HINT, weekPlan } from "@/modules/ganztag/essen";
import { canManage, dateLabel } from "@/modules/ganztag/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DayMenuForm } from "./forms";

export const metadata: Metadata = { title: "Ganztag: Mittagessen" };

/**
 * GT-11/GT-12: Speiseplan je Woche (nur „Ganztag verwalten“ pflegt) mit Zahl der Anmeldungen je Menü; Ausgabeliste je Tag und CSV
 * für die Küche. „Ganztag auswerten“ sieht nur die Zahlen.
 */
export default async function EssenPage({ searchParams }: { searchParams: Promise<{ woche?: string }> }) {
  const { perms } = await requireUser();
  if (!canSeeCounts(perms)) notFound();
  const { woche } = await searchParams;
  const plan = await weekPlan(await getDb(), perms, woche ?? toBerlinDate(new Date()));
  const manager = canManage(perms);
  const friday = addDays(plan.monday, 4);

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ganztag">
          <ArrowLeft aria-hidden /> Ganztag
        </Link>
      </Button>
      <PageHeader
        eyebrow="Ganztag"
        title="Mittagessen"
        actions={
          <Button asChild variant="secondary">
            <a href={`/api/ganztag/essen?von=${plan.monday}&bis=${friday}`} download>
              <Download aria-hidden /> CSV für die Küche
            </a>
          </Button>
        }
      />
      <p className="text-muted">
        Speiseplan von Hand: je Tag bis zu {MAX_MENUS} nummerierte Menüs mit Kurzbeschreibung. Familien melden je Tag an oder ab; gezählt wird je Menü, ohne Abrechnung. {MEAL_HINT}
      </p>
      {manager && (
        <p className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
          Menüs nach dem Gericht benennen, nicht nach einer Kostform oder Diät – sonst ließe die Wahl Rückschlüsse auf Gesundheit oder Religion zu. Allergene und Zusatzstoffe gehören auf den Aushang der Küche, nicht
          in SchulOS.
        </p>
      )}
      <nav aria-label="Woche wählen" className="flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href={`/ganztag/essen?woche=${addDays(plan.monday, -7)}`}>
            <ChevronLeft aria-hidden /> Vorwoche
          </Link>
        </Button>
        <span className="font-medium">
          {dateLabel(plan.monday)} bis {dateLabel(friday)}
        </span>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/ganztag/essen?woche=${addDays(plan.monday, 7)}`}>
            Nächste Woche <ChevronRight aria-hidden />
          </Link>
        </Button>
      </nav>
      <ul className="flex flex-col gap-4" aria-label="Speiseplan der Woche">
        {plan.days.map((d) => {
          const total = Object.values(d.orders).reduce((a, b) => a + b, 0);
          return (
            <li key={d.date}>
              <Card className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">{dateLabel(d.date)}</h2>
                  <span className="text-sm text-muted">{total === 1 ? "1 Anmeldung" : `${total} Anmeldungen`}</span>
                </div>
                {manager ? (
                  <DayMenuForm date={d.date} label={dateLabel(d.date)} menus={d.menus} orders={d.orders} />
                ) : d.menus.length === 0 ? (
                  <p className="text-sm text-muted">Kein Essen geplant.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {d.menus.map((m) => (
                      <li key={m.number} className="text-sm">
                        Menü {m.number}: {m.title} – {d.orders[m.number] ?? 0}
                      </li>
                    ))}
                  </ul>
                )}
                {manager && d.menus.length > 0 && (
                  <Button asChild variant="ghost" size="sm" className="self-start">
                    <Link href={`/ganztag/essen/ausgabe?datum=${d.date}`}>Ausgabeliste {dateLabel(d.date)}</Link>
                  </Button>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
