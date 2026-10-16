import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { createTopicAction } from "@/modules/foren/actions";
import { forumAccess, listTopics } from "@/modules/foren/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { TopicForm } from "../post-forms";

export const metadata: Metadata = { title: "Forum" };

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export default async function ForumPage({ params }: { params: Promise<{ key: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const key = decodeURIComponent((await params).key);
  const access = await forumAccess(db, perms, key);
  if (!access) notFound();
  const { name } = access;
  const topics = await listTopics(db, perms, key);
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Forum"
        title={name}
        actions={
          <Link href="/foren" className="text-sm font-medium text-accent-ink hover:underline">
            Alle Foren
          </Link>
        }
      />
      {topics.length === 0 ? (
        <EmptyState title="Noch keine Themen" />
      ) : (
        <ul className="flex flex-col gap-2">
          {topics.map((t) => (
            <li key={t.id}>
              <Link href={`/foren/thema/${t.id}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                <span className="flex items-center gap-2 font-semibold">
                  {t.locked && <Lock className="size-4 text-muted" aria-label="gesperrt" />}
                  {t.title}
                </span>
                <span className="text-sm text-muted">
                  {t.authorName ?? "Unbekannt"} · {t.posts} {t.posts === 1 ? "Beitrag" : "Beiträge"} · {fmt.format(t.lastPostAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {access.write && (
      <Card aria-labelledby="neu">
        <h2 id="neu" className="text-base font-semibold">
          Neues Thema
        </h2>
        <TopicForm action={createTopicAction.bind(null, key)} />
      </Card>
      )}
    </main>
  );
}
