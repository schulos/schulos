import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canEditAll, canManage, listOutline } from "@/modules/hilfe/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { NewSectionForm, SectionRow } from "./section-forms";

export const metadata: Metadata = { title: "Bereiche des Handbuchs" };

export default async function HilfeBereichePage() {
  const { perms } = await requireUser();
  if (!canEditAll(perms)) notFound();
  const outline = await listOutline(await getDb(), perms);
  const manage = canManage(perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <Link href="/hilfe" className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Handbuch
      </Link>
      <PageHeader eyebrow="Handbuch" title="Bereiche" />
      <p className="text-muted">Bereiche gliedern das Handbuch (Bereich → Seite). Ein Bereich mit Seiten lässt sich erst löschen, wenn er leer ist.</p>
      <Card>
        <NewSectionForm />
      </Card>
      {outline.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Bereiche">
          {outline.map((s, i) => (
            <SectionRow key={`${s.id}:${s.title}`} id={s.id} title={s.title} pages={s.pages.length} canDelete={manage} first={i === 0} last={i === outline.length - 1} />
          ))}
        </ul>
      )}
    </main>
  );
}
