import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { updatePostAction } from "@/modules/news/actions";
import { canEdit, canManage, getPost, targetableGroups } from "@/modules/news/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { PostForm } from "../../post-form";

export const metadata: Metadata = { title: "Beitrag bearbeiten" };

const ymd = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }); // liefert YYYY-MM-DD

export default async function NewsEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const post = await getPost(db, perms, decodeURIComponent(id));
  if (!post || !canEdit(perms, post)) notFound();
  const groups = await targetableGroups(db, perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="News" title="Beitrag bearbeiten" />
      <Card>
        <PostForm
          action={updatePostAction.bind(null, post.id)}
          groups={groups}
          canPin={canManage(perms)}
          submitLabel="Speichern"
          showNotify={false}
          initial={{
            title: post.title,
            body: post.body,
            pinned: post.pinned,
            onMonitor: post.onMonitor,
            expiresAt: post.expiresAt ? ymd.format(post.expiresAt) : "",
            targetRoles: post.targetRoles,
            targetGroupIds: post.targetGroupIds,
          }}
        />
      </Card>
    </main>
  );
}
