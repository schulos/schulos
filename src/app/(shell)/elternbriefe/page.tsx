import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { isSelfResponsible } from "@/core/school/majority";
import { TZ, fromBerlinLocal } from "@/core/time";
import { listLetters } from "@/modules/elternbriefe/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader, Progress } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Elternbriefe" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

export default async function ElternbriefePage() {
  const { user, perms } = await requireUser();
  const db = await getDb();
  // Q5-05: eigenständige Schüler:innen bekommen Elternbriefe selbst
  const parent = user.role === "eltern" || (user.role === "schueler" && (await isSelfResponsible(db, user.id)));
  const canSend = hasPermission(perms, "elternbriefe.send");
  if (!parent && !canSend) notFound();
  const letters = await listLetters(db, perms);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Kommunikation"
        title="Elternbriefe"
        actions={
          canSend && (
            <Button asChild variant="primary">
              <Link href="/elternbriefe/neu">
                <Plus aria-hidden /> Neuer Elternbrief
              </Link>
            </Button>
          )
        }
      />
      {letters.length === 0 ? (
        <EmptyState title="Noch keine Elternbriefe" />
      ) : (
        <ul className="flex flex-col gap-2">
          {letters.map((l) => (
            <li key={l.id}>
              <Link href={`/elternbriefe/${l.id}`} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{l.title}</span>
                  {parent ? (
                    l.openFor.length > 0 ? (
                      <Badge tone="warn">Rückmeldung offen{l.openFor.length < l.total ? `: ${l.openFor.join(", ")}` : ""}</Badge>
                    ) : (
                      <Badge tone="success">bestätigt</Badge>
                    )
                  ) : (
                    <span className="text-sm text-muted">
                      {l.confirmed} von {l.total} bestätigt
                    </span>
                  )}
                </span>
                <span className="text-sm text-muted">
                  {dateFmt.format(l.createdAt)}
                  {l.dueDate && ` · Rückmeldung bis ${dateFmt.format(fromBerlinLocal(l.dueDate))}`}
                </span>
                {!parent && <Progress value={(l.confirmed / Math.max(1, l.total)) * 100} label={`${l.confirmed} von ${l.total} bestätigt`} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
