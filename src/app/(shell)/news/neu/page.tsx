import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { createPostAction } from "@/modules/news/actions";
import { canManage, canWrite, targetableGroups } from "@/modules/news/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { PostForm } from "../post-form";

export const metadata: Metadata = { title: "Beitrag schreiben" };

export default async function NewsNeuPage() {
  const { perms } = await requireUser();
  if (!canWrite(perms)) notFound();
  const groups = await targetableGroups(await getDb(), perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="News" title="Beitrag schreiben" />
      <Card>
        <PostForm action={createPostAction} groups={groups} canPin={canManage(perms)} submitLabel="Veröffentlichen" showNotify />
      </Card>
    </main>
  );
}
