import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { rooms, subjects } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { hasPermission } from "@/core/permissions";
import { TZ, toBerlinDate } from "@/core/time";
import { EDIT, listPlans, myGroups } from "@/modules/sitzplan/service";
import { layoutOptions } from "@/modules/verwaltung/raumlayout";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NewPlanForm } from "./forms";

export const metadata: Metadata = { title: "Sitzpläne" };
export const dynamic = "force-dynamic";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", year: "numeric", timeZone: TZ });

/** Sitzpläne (P5-01/P5-02): eigene Lerngruppen mit ihren Plänen, „Neuer Sitzplan“. Nur Lehrkräfte der Gruppe und Klassenleitung. */
export default async function SitzplanPage({ searchParams }: { searchParams: Promise<{ gruppe?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, EDIT)) notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [groups, plans, subjectRows, roomRows, sp, layouts] = await Promise.all([
    myGroups(db, perms, today),
    listPlans(db, perms, today),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(subjects.sortOrder, de(subjects.name)),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).orderBy(rooms.id),
    searchParams,
    layoutOptions(db, perms),
  ]);
  const preselect = groups.find((g) => g.id === sp.gruppe);
  const byGroup = new Map<string, typeof plans>();
  for (const p of plans) byGroup.set(p.groupId, [...(byGroup.get(p.groupId) ?? []), p]);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Sitzpläne" />
      <p className="max-w-3xl text-sm text-muted">
        Sitzpläne siehst nur du und die anderen Lehrkräfte der Lerngruppe (einschließlich Klassenleitung) – nicht Schüler:innen, Eltern oder die
        Verwaltung. Am Platz steht das Profilbild nur bei Einwilligung, sonst die Initialen; der Druck enthält nie Fotos.
      </p>
      {groups.length === 0 ? (
        <EmptyState title="Keine eigenen Lerngruppen">Sitzpläne gibt es für Klassen und Kurse, in denen du unterrichtest oder die du leitest.</EmptyState>
      ) : (
        <>
          <Card aria-labelledby="neu">
            <h2 id="neu" className="text-base font-semibold">
              Neuer Sitzplan
            </h2>
            <NewPlanForm
              groups={groups.map((g) => ({ id: g.id, name: g.name, subjectId: g.subjectId, roomId: g.homeRoomId }))}
              subjects={subjectRows}
              rooms={roomRows}
              defaultGroupId={preselect?.id ?? groups[0]!.id}
              layouts={layouts.map((l) => ({ id: l.id, label: `${l.roomId} – ${l.name}${l.isDefault ? " (Standard)" : ""}, ${l.seats} Plätze` }))}
            />
          </Card>
          <section aria-labelledby="liste" className="flex flex-col gap-3">
            <h2 id="liste" className="font-display text-xl font-bold">
              Meine Lerngruppen
            </h2>
            <ul className="rounded-card border border-border bg-surface px-4">
              {groups.map((g) => {
                const own = byGroup.get(g.id) ?? [];
                return (
                  <li key={g.id} className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0">
                    <span className="font-medium">{g.name}</span>
                    {own.length === 0 ? (
                      <span className="text-sm text-muted">Noch kein Sitzplan.</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {own.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                            <Link href={`/sitzplan/${p.id}`} className="font-medium text-accent-ink hover:underline">
                              {p.title}
                            </Link>
                            <span className="text-muted">
                              {[p.subjectName, p.roomId && `Raum ${p.roomId}`, `${p.seated} ${p.seated === 1 ? "Platz" : "Plätze"} belegt`, `geändert ${dayFmt.format(p.updatedAt)}`]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
