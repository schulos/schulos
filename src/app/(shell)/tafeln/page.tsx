import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { boardGroups, listBoards } from "@/modules/tafeln/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NewBoardForm } from "./new-board";

export const metadata: Metadata = { title: "Tafeln" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function TafelnPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [list, groups] = await Promise.all([listBoards(db, perms), boardGroups(db, perms)]);
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Tafeln" />
      {list.length === 0 ? (
        <EmptyState title="Noch keine Tafel">Tafeln liegen als Datei „*.excalidraw“ im Gruppenordner – leg unten eine an.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Tafeln">
          {list.map((b) => (
            <li key={b.id}>
              <Link href={`/tafeln/${b.id}`} className="flex h-full flex-col gap-1 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                <span className="font-semibold">{b.title}</span>
                <span className="text-sm text-muted">
                  {b.groupName} · {stamp.format(b.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Neue Tafel
          </h2>
          <NewBoardForm groups={groups} />
          <p className="text-sm text-muted">Die Tafel landet im Gruppenordner; umbenennen, verschieben und löschen geht dort unter „Dateien“.</p>
        </Card>
      )}
    </main>
  );
}
