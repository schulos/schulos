import type { Metadata } from "next";
import { photoUrl } from "@/core/privacy/profilbild";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import { getGroupProfile } from "@/modules/adressbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { Avatar, initials, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Gruppe" };

export default async function GruppePage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const data = await getGroupProfile(await getDb(), perms, decodeURIComponent(id));
  if (!data) notFound();
  const { group, members } = data;
  const leaders = members.filter((m) => m.memberRole === "leader");
  const rest = members.filter((m) => m.memberRole !== "leader");

  const row = (m: (typeof members)[number]) => (
    <li key={m.id}>
      <Link href={`/adressbuch/person/${m.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
        <Avatar label={m.shortCode ?? initials(m.name)} src={photoUrl(m.id, m.photoAt)} tone={m.memberRole === "leader" ? "ink" : "soft"} className="size-8 text-xs" />
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{m.name}</span>
          <span className="text-xs text-muted">{ROLE_LABELS[m.role]}</span>
        </span>
      </Link>
    </li>
  );

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow={GROUP_KIND_LABELS[group.kind]} title={group.name} />
      {group.description && <p className="text-muted">{group.description}</p>}
      {leaders.length > 0 && (
        <Card>
          <CardHeader title="Leitung" />
          <ul className="grid gap-1 sm:grid-cols-2">{leaders.map(row)}</ul>
        </Card>
      )}
      <Card>
        <CardHeader title={<span className="flex items-center gap-2">Mitglieder <Badge>{rest.length}</Badge></span>} />
        <ul className="grid gap-1 sm:grid-cols-2">{rest.map(row)}</ul>
      </Card>
    </main>
  );
}
