import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { boardGroups, listBoards, MODE_LABELS } from "@/modules/pinnwaende/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NewBoardForm } from "./new-board";

export const metadata: Metadata = { title: "Pinnwände" };

export default async function PinnwaendePage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [list, groups] = await Promise.all([listBoards(db, perms), boardGroups(db, perms)]);
  const canFree = hasPermission(perms, "pinnwaende.create");
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Pinnwände" />
      {list.length === 0 ? (
        <EmptyState title="Noch keine Pinnwand" />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((b) => (
            <li key={b.id}>
              <Link href={`/pinnwaende/${b.id}`} className="flex h-full flex-col gap-1 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                <span className="font-semibold">{b.title}</span>
                <span className="text-sm text-muted">
                  {b.groupName ?? "Freie Pinnwand"} · {MODE_LABELS[b.mode]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(canFree || groups.length > 0) && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Neue Pinnwand
          </h2>
          <NewBoardForm groups={groups} canFree={canFree} />
        </Card>
      )}
    </main>
  );
}
