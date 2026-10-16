import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { replyAction } from "@/modules/foren/actions";
import { getTopic } from "@/modules/foren/service";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { PageHeader } from "@schulos/ui/misc";
import { PostForm } from "../../post-forms";
import { HidePost, LockToggle, ReportPost, UnhidePost } from "./moderation-client";
import { EditPost, SubscribeToggle } from "./topic-client";

export const metadata: Metadata = { title: "Thema" };

const fmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export default async function ThemaPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const data = await getTopic(await getDb(), perms, (await params).id);
  if (!data) notFound();
  const { topic, posts } = data;
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={data.forumName}
        title={topic.title}
        actions={
          <>
            {data.canModerate && <LockToggle topicId={topic.id} locked={topic.locked} />}
            {data.canWrite && <SubscribeToggle topicId={topic.id} subscribed={data.subscribed} />}
            <Link href={`/foren/${data.key}`} className="self-center text-sm font-medium text-accent-ink hover:underline">
              Zum Forum
            </Link>
          </>
        }
      />
      <ol aria-label="Beiträge" className="flex flex-col gap-3">
        {posts.map((post) => (
          <li key={post.id} id={post.id} className="flex scroll-mt-24 flex-col gap-2 rounded-card border border-border bg-surface p-4">
            <p className="text-sm text-muted">
              <span className="font-medium text-ink">{post.authorName ?? "Gelöschtes Konto"}</span> · {fmt.format(post.createdAt)}
              {post.editedAt && " · bearbeitet"}
            </p>
            {post.hiddenAt && (
              <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
                Von der Moderation ausgeblendet{post.hiddenReason ? `: ${post.hiddenReason}` : ""}
              </p>
            )}
            {post.body !== null && (
              <div className={post.hiddenAt ? "opacity-60" : undefined}>
                <Markdown>{post.body}</Markdown>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {post.mine && !topic.locked && !post.hiddenAt && <EditPost topicId={topic.id} postId={post.id} body={post.body ?? ""} />}
              {!post.mine && !post.hiddenAt && <ReportPost postId={post.id} />}
              {data.canModerate && (post.hiddenAt ? <UnhidePost topicId={topic.id} postId={post.id} /> : <HidePost topicId={topic.id} postId={post.id} />)}
            </div>
          </li>
        ))}
      </ol>
      {topic.locked ? (
        <p className="text-muted">Dieses Thema ist gesperrt – Antworten sind nicht mehr möglich.</p>
      ) : !data.canWrite ? (
        <p className="text-muted">Du moderierst dieses Forum, schreibst aber nicht mit (nur Mitglieder der Gruppe).</p>
      ) : (
        <Card aria-labelledby="antworten">
          <h2 id="antworten" className="text-base font-semibold">
            Antworten
          </h2>
          <PostForm action={replyAction.bind(null, topic.id)} label="Deine Antwort" submitLabel="Antwort senden" />
        </Card>
      )}
    </main>
  );
}
