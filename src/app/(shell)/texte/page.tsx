import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { docGroups, listDocs, MODE_LABELS } from "@/modules/texte/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NewDocForm } from "./new-doc";

export const metadata: Metadata = { title: "Texte" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

export default async function TextePage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [list, groups] = await Promise.all([listDocs(db, perms), docGroups(db, perms)]);
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Texte" />
      {list.length === 0 ? (
        <EmptyState title="Noch kein Text">Texte gibt es in Gruppen mit dem Bereich „Texte“ – die Leitung legt sie an.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Texte">
          {list.map((d) => (
            <li key={d.id}>
              <Link href={`/texte/${d.id}`} className="flex h-full flex-col gap-1 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                <span className="font-semibold">{d.title}</span>
                <span className="text-sm text-muted">
                  {d.groupName} · {MODE_LABELS[d.mode]} · {stamp.format(d.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Neuer Text
          </h2>
          <NewDocForm groups={groups} />
        </Card>
      )}
    </main>
  );
}
