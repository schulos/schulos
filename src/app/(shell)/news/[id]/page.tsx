import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil, Pin } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canEdit, getPost } from "@/modules/news/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { DeletePost } from "./delete-post";

export const metadata: Metadata = { title: "Beitrag" };

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Berlin" });
const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });

export default async function NewsDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const post = await getPost(await getDb(), perms, decodeURIComponent(id));
  if (!post) notFound();
  const editable = canEdit(perms, post);

  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <Link href="/news" className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Alle News
      </Link>
      <Card className="gap-5 p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {post.pinned && (
            <Badge tone="soft">
              <Pin className="size-3" aria-hidden /> Angeheftet
            </Badge>
          )}
          <span>
            {post.authorName ?? "Unbekannt"} · {fmt.format(post.publishedAt)}
          </span>
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{post.title}</h1>
        <Markdown>{post.body}</Markdown>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm text-muted">
          <span>
            {post.targets.length ? `An: ${post.targets.join(", ")}` : "An alle"}
            {post.expiresAt && ` · sichtbar bis ${day.format(post.expiresAt)}`}
          </span>
          {editable && (
            <span className="flex gap-2">
              <Button asChild size="sm">
                <Link href={`/news/${post.id}/bearbeiten`}>
                  <Pencil aria-hidden /> Bearbeiten
                </Link>
              </Button>
              <DeletePost id={post.id} />
            </span>
          )}
        </footer>
      </Card>
    </main>
  );
}
