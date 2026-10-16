import type { Metadata } from "next";
import { photoUrl } from "@/core/privacy/profilbild";
import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import { listCounselors, listTeachers, searchGroups, searchPeople } from "@/modules/adressbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { Input } from "@schulos/ui/field";
import { Avatar, EmptyState, initials, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { de } from "@/core/db/sort";

export const metadata: Metadata = { title: "Adressbuch" };

export default async function AdressbuchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { perms } = await requireUser();
  const { q } = await searchParams;
  const db = await getDb();
  const query = q?.trim() ?? "";

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Adressbuch" />
      <form role="search">
        <Input name="q" type="search" defaultValue={query} placeholder="Person, Kürzel oder Gruppe suchen …" aria-label="Adressbuch durchsuchen" />
      </form>
      {query ? <Results q={query} /> : <Overview />}
    </main>
  );

  async function Results({ q }: { q: string }) {
    const [people, grps] = await Promise.all([searchPeople(db, perms, q, 30), searchGroups(db, perms, q, 20)]);
    if (people.length === 0 && grps.length === 0) return <EmptyState title={`Nichts gefunden für „${q}“`} />;
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        {people.length > 0 && (
          <Card>
            <CardHeader title={`Personen (${people.length})`} />
            <ul className="flex flex-col gap-1">
              {people.map((p) => (
                <li key={p.id}>
                  <Link href={`/adressbuch/person/${p.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                    <Avatar label={p.shortCode ?? initials(p.name)} tone="soft" className="size-8 text-xs" />
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted">{ROLE_LABELS[p.role]}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {grps.length > 0 && (
          <Card>
            <CardHeader title={`Gruppen (${grps.length})`} />
            <ul className="flex flex-col gap-1">
              {grps.map((g) => (
                <li key={g.id}>
                  <Link href={`/adressbuch/gruppe/${g.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                    <span className="font-medium">{g.name}</span>
                    <Badge>{GROUP_KIND_LABELS[g.kind]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  async function Overview() {
    const [teachers, counselors, mine] = await Promise.all([
      listTeachers(db),
      listCounselors(db),
      perms.memberOf.size
        ? db.select({ id: groups.id, name: groups.name, kind: groups.kind }).from(groups).where(inArray(groups.id, [...perms.memberOf])).orderBy(asc(groups.kind), de(groups.name))
        : [],
    ]);
    return (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title={`Lehrkräfte (${teachers.length})`} />
          <ul className="grid gap-1 sm:grid-cols-2">
            {teachers.map((t) => (
              <li key={t.id}>
                <Link href={`/adressbuch/person/${t.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                  <Avatar label={t.shortCode ?? initials(t.name)} src={photoUrl(t.id, t.photoAt)} className="size-9 text-xs" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                    <span className="truncate font-medium">
                      {t.lastName}, {t.firstName}
                    </span>
                    <span className="flex gap-1.5">
                      {t.subjects.map((s) => (
                        <span key={s.name} className="flex items-center gap-1 text-xs text-muted">
                          <SubjectBar color={s.color} className="h-2 w-2 rounded-full" />
                          {s.name}
                        </span>
                      ))}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <div className="flex flex-col gap-6">
          {counselors.length > 0 && (
            <Card>
              <CardHeader title="Schulsozialarbeit & Beratung" />
              <ul className="flex flex-col gap-1">
                {counselors.map((c) => (
                  <li key={c.id}>
                    <Link href={`/adressbuch/person/${c.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                      <Avatar label={initials(c.name)} src={photoUrl(c.id, c.photoAt)} className="size-9 text-xs" />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate font-medium">
                          {c.lastName}, {c.firstName}
                        </span>
                        {c.officeHours && <span className="text-xs text-muted">{c.officeHours}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Meine Gruppen" />
            {mine.length === 0 ? (
              <p className="text-sm text-muted">Keine Gruppen.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {mine.map((g) => (
                  <li key={g.id}>
                    <Link href={`/adressbuch/gruppe/${g.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                      <span className="font-medium">{g.name}</span>
                      <Badge>{GROUP_KIND_LABELS[g.kind]}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    );
  }
}
