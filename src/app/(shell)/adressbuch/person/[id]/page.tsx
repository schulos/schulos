import type { Metadata } from "next";
import { photoUrl } from "@/core/privacy/profilbild";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import { getPersonProfile } from "@/modules/adressbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { Avatar, initials, SubjectBar } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Profil" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const profile = await getPersonProfile(await getDb(), perms, decodeURIComponent(id));
  if (!profile) notFound();
  const { person, subjects, classLeads, groups, groupsAreShared } = profile;

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <div className="flex items-center gap-5">
        <Avatar label={person.shortCode ?? initials(person.name)} src={photoUrl(person.id, person.photoAt)} className="size-16 rounded-2xl text-lg" />
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-bold tracking-tight">{person.name}</h1>
          <p className="text-muted">
            {ROLE_LABELS[person.role]}
            {person.shortCode && ` · Kürzel ${person.shortCode}`}
            {classLeads.length > 0 && ` · Klassenleitung ${classLeads.map((c) => c.replace("Klasse ", "")).join(", ")}`}
          </p>
        </div>
      </div>
      {person.role === "beratung" && (
        <Card>
          <CardHeader title="Sprechzeiten und Raum" />
          <p className="text-sm">{person.officeHours ?? "Noch keine Sprechzeiten eingetragen – bitte im Sekretariat nachfragen."}</p>
          <p className="mt-2 text-xs text-muted">Schulsozialarbeit: vertraulich, freiwillig, kostenlos. Termine bitte persönlich, telefonisch oder in den Sprechzeiten.</p>
        </Card>
      )}
      {subjects.length > 0 && (
        <Card>
          <CardHeader title="Fächer" />
          <ul className="flex flex-wrap gap-4">
            {subjects.map((s) => (
              <li key={s.name} className="flex min-w-28 flex-col gap-1.5">
                <SubjectBar color={s.color} />
                <span className="text-sm">{s.name}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader title={groupsAreShared ? "Gemeinsame Gruppen" : "Gruppen"} />
        {groups.length === 0 ? (
          <p className="text-sm text-muted">{groupsAreShared ? "Ihr habt keine gemeinsamen Gruppen." : "Keine Gruppen."}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {groups.map((g) => (
              <li key={g.id}>
                <Link href={`/adressbuch/gruppe/${g.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                  <span className="font-medium">{g.name}</span>
                  <span className="flex gap-1.5">
                    {g.memberRole === "leader" && <Badge tone="soft">Leitung</Badge>}
                    <Badge>{GROUP_KIND_LABELS[g.kind]}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
