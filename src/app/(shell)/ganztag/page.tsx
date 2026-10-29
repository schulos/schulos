import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Settings2, Users } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { canEvaluate } from "@/modules/ganztag/auswertung";
import { familyView } from "@/modules/ganztag/familie";
import { leadsClass } from "@/modules/ganztag/klassenleitung";
import { canManage, dateLabel, listOffers } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { FamilyGanztag } from "./familie";

export const metadata: Metadata = { title: "Ganztag" };

export default async function GanztagPage() {
  const { user, perms } = await requireUser();
  const db = await getDb();

  // GT-05: Schüler:innen und Eltern sehen nur die eigenen Zeilen bzw. die ihres Kindes
  if (user.role === "schueler" || user.role === "eltern") {
    const self = user.role === "schueler";
    const children = await familyView(db, perms);
    return (
      <main className="flex max-w-4xl flex-col gap-6">
        <PageHeader title="Ganztag" />
        <p className="text-muted">
          {self ? "Deine AGs und Kurse mit Anwesenheitsliste und deine eigene Anwesenheit." : "AGs und Kurse mit Anwesenheitsliste und die Anwesenheit Ihres Kindes."} Entschuldigt wird über die
          Abwesenheiten.
        </p>
        {children.length === 0 ? (
          <EmptyState title="Keine Kinder zu sehen">Volljährige, eigenständige Schüler:innen sehen ihre Anwesenheit selbst – es sei denn, sie haben eingewilligt, dass ihre Eltern weiter informiert werden.</EmptyState>
        ) : (
          children.map((c) => <FamilyGanztag key={c.id} child={c} self={self} />)
        )}
      </main>
    );
  }

  const manager = canManage(perms);
  const [offers, classLead] = await Promise.all([listOffers(db, perms), leadsClass(db, perms)]);
  const evaluate = canEvaluate(perms);

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Ganztag"
        actions={
          (manager || evaluate || classLead) && (
            <>
              {classLead && (
                <Button asChild variant="secondary">
                  <Link href="/ganztag/klasse">
                    <Users aria-hidden /> Meine Klasse
                  </Link>
                </Button>
              )}
              {evaluate && (
                <Button asChild variant="secondary">
                  <Link href="/ganztag/auswertung">
                    <BarChart3 aria-hidden /> Auswertung
                  </Link>
                </Button>
              )}
              {manager && (
                <Button asChild>
                  <Link href="/ganztag/angebote">
                    <Settings2 aria-hidden /> Angebote mit Liste
                  </Link>
                </Button>
              )}
            </>
          )
        }
      />
      <p className="text-muted">Anwesenheitslisten für AGs, Förderkurse und Ganztagsangebote. Die Liste startet leer – erfasst wird per Klick.</p>

      {offers.length === 0 ? (
        <EmptyState title={manager ? "Noch keine Angebote mit Anwesenheitsliste" : "Keine Angebote mit Anwesenheitsliste"}>
          {manager
            ? "Unter „Angebote mit Liste“ die Anwesenheitsliste für AGs, Förderkurse oder freie Gruppen einschalten."
            : "Hier erscheinen die AGs und Kurse, die du leitest, sobald die Verwaltung die Anwesenheitsliste für sie eingeschaltet hat."}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Angebote">
          {offers.map((o) => (
            <li key={o.id}>
              <Card className="h-full gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">
                    {GROUP_KIND_LABELS[o.kind]}
                    {o.leaders.length > 0 && ` · ${o.leaders.join(", ")}`}
                  </span>
                  <h2 className="text-lg font-semibold">
                    <Link href={`/ganztag/gruppe/${o.id}`} className="hover:underline">
                      {o.name}
                    </Link>
                  </h2>
                </div>
                {o.today.length > 0 && (
                  <ul className="flex flex-col gap-2" aria-label={`Heute in ${o.name}`}>
                    {o.today.map((t) => (
                      <li key={t.id}>
                        <Link href={`/ganztag/termin/${t.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 hover:bg-surface-2">
                          <span className="font-medium">
                            Heute {t.startsAt}–{t.endsAt}
                          </span>
                          {t.status === "ausgefallen" ? <Badge tone="warn">fällt aus</Badge> : t.status === "erfasst" ? <Badge tone="success">erfasst</Badge> : <Badge tone="soft">Liste öffnen</Badge>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-sm text-muted">
                  {o.next ? `Nächster Termin: ${dateLabel(o.next.date)}, ${o.next.startsAt} Uhr` : "Kein weiterer Termin geplant"}
                </p>
                {o.open > 0 && <Badge tone="warn" className="self-start">{o.open === 1 ? "1 Liste noch offen" : `${o.open} Listen noch offen`}</Badge>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
