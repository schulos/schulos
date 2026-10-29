import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canEditAll, getPage, listRevisions, REVISIONS_KEEP } from "@/modules/hilfe/service";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { RestoreButton } from "./restore-button";

export const metadata: Metadata = { title: "Seitenverlauf" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Berlin" });

/** HB-06: frühere Fassungen einer Seite ansehen und wiederherstellen – nur Pflegende. */
export default async function HilfeVerlaufPage({ params }: { params: Promise<{ slug: string }> }) {
  const { perms } = await requireUser();
  if (!canEditAll(perms)) notFound();
  const db = await getDb();
  const page = await getPage(db, perms, decodeURIComponent((await params).slug));
  if (!page) notFound();
  const revisions = await listRevisions(db, perms, page.id);
  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <nav aria-label="Brotkrumen" className="text-sm text-muted">
        <Link href={`/hilfe/${page.slug}`} className="inline-flex items-center gap-1.5 hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> {page.title}
        </Link>
      </nav>
      <PageHeader eyebrow="Handbuch" title="Seitenverlauf" />
      <p className="text-sm text-muted">
        Beim Ändern von Titel oder Text bleibt der bisherige Stand hier erhalten – die letzten {REVISIONS_KEEP} Fassungen. Beim Wiederherstellen wird der
        aktuelle Stand selbst zur Fassung, es geht nichts verloren.
      </p>
      {revisions.length === 0 ? (
        <EmptyState title="Noch keine früheren Fassungen">Sobald Titel oder Text geändert werden, erscheint hier die vorherige Fassung.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {revisions.map((r) => (
            <li key={r.id}>
              <Card className="gap-3" aria-label={`Fassung vom ${stamp.format(r.authoredAt)}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted">
                    <strong className="text-ink">{stamp.format(r.authoredAt)}</strong>
                    {r.authorName ? ` · ${r.authorName}` : ""}
                  </p>
                  <RestoreButton id={r.id} />
                </div>
                <h2 className="text-lg font-semibold">{r.title}</h2>
                <details>
                  <summary className="cursor-pointer text-sm text-accent-ink">Text anzeigen</summary>
                  <div className="pt-3">{r.body ? <Markdown>{r.body}</Markdown> : <p className="text-muted">Kein Text.</p>}</div>
                </details>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
