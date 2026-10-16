import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { hasPermission } from "@/core/permissions";
import kurse from "@/modules/kurse/manifest";
import { myCourses, searchCourses } from "@/modules/kurse/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input } from "@schulos/ui/field";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Meine Kurse" };

export default async function KursePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const all = hasPermission(perms, "kurse.view_all");
  if (!isEnabled(kurse, await loadModuleStates(db)) || !(all || hasPermission(perms, "kurse.view"))) notFound();
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const [courses, found] = await Promise.all([myCourses(db, perms), searchCourses(db, perms, q)]);
  const kinds = [...new Set(courses.map((c) => c.kind))];

  return (
    <main className="flex max-w-5xl flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Meine Kurse" />
      {courses.length === 0 ? (
        <EmptyState title="Du bist noch in keiner Gruppe">Klassen, Kurse und AGs erscheinen hier, sobald dich die Verwaltung einträgt.</EmptyState>
      ) : (
        kinds.map((kind) => (
          <section key={kind} aria-labelledby={`art-${kind}`} className="flex flex-col gap-3">
            <h2 id={`art-${kind}`} className="text-sm font-semibold text-muted">
              {courses.find((c) => c.kind === kind)!.kindLabel}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {courses
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <li key={c.id}>
                    <Link href={`/kurse/${c.id}`} className="flex h-full items-stretch gap-3 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                      <SubjectBar color={c.color ?? "var(--border-strong)"} className="h-auto w-1 shrink-0" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="font-semibold">{c.name}</span>
                          {c.leader && <Badge tone="soft">Leitung</Badge>}
                        </span>
                        <span className="text-sm text-muted">
                          {c.subjectName ? `${c.subjectName} · ` : ""}
                          {c.members} Mitglieder
                          {c.leaders.length > 0 && ` · ${c.leaders.join(", ")}`}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
      {all && (
        <Card aria-labelledby="alle">
          <h2 id="alle" className="text-base font-semibold">
            Kursraum einer anderen Gruppe öffnen
          </h2>
          <form className="flex flex-wrap gap-2" role="search">
            <Input name="q" type="search" defaultValue={q} placeholder="Name oder Kürzel, z. B. 7b" aria-label="Gruppe suchen" className="min-w-0 flex-1" />
            <Button type="submit">Suchen</Button>
          </form>
          {q && found.length === 0 && <p className="text-sm text-muted">Keine Gruppe gefunden.</p>}
          {found.length > 0 && (
            <ul className="flex flex-col">
              {found.map((g) => (
                <li key={g.id} className="border-t border-border first:border-t-0">
                  <Link href={`/kurse/${g.id}`} className="flex items-baseline justify-between gap-3 py-2 hover:underline">
                    <span className="font-medium">{g.name}</span>
                    <span className="text-sm text-muted">
                      {GROUP_KIND_LABELS[g.kind]} · {g.members} Mitglieder
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </main>
  );
}
