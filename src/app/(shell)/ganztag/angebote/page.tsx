import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { canManage, listEligibleGroups } from "@/modules/ganztag/service";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { ListToggle } from "./list-toggle";

export const metadata: Metadata = { title: "Ganztag: Angebote mit Liste" };

export default async function AngebotePage() {
  const { perms } = await requireUser();
  if (!canManage(perms)) notFound();
  const groups = await listEligibleGroups(await getDb(), perms);

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Ganztag" title="Angebote mit Liste" />
      <p className="text-muted">
        Für welche Gruppen wird eine Anwesenheitsliste geführt? Möglich für AGs, Förderkurse und freie Gruppen. Ausschalten blendet die Liste aus,
        erfasste Termine bleiben bis zum Schuljahresende.
      </p>
      {groups.length === 0 ? (
        <EmptyState title="Keine passenden Gruppen">Zuerst unter Verwaltung → Gruppen eine AG, einen Förderkurs oder eine freie Gruppe anlegen.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Gruppen">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col">
                {g.listOn ? (
                  <Link href={`/ganztag/gruppe/${g.id}`} className="font-medium hover:underline">
                    {g.name}
                  </Link>
                ) : (
                  <span className="font-medium">{g.name}</span>
                )}
                <span className="text-xs text-muted">
                  {GROUP_KIND_LABELS[g.kind]} · {g.members === 1 ? "1 Mitglied" : `${g.members} Mitglieder`}
                  {g.leaders.length > 0 ? ` · Leitung ${g.leaders.join(", ")}` : " · ohne Leitung"}
                </span>
              </div>
              <ListToggle groupId={g.id} name={g.name} on={g.listOn} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
