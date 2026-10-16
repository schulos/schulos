import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { exportMarkdown } from "@/modules/texte/service";
import { Button } from "@schulos/ui/button";
import { Markdown } from "@schulos/ui/markdown";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Text drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/** P3-11: Druckansicht bzw. PDF (über „Drucken“ → „Als PDF speichern“) – gerendert aus dem Markdown-Export. */
export default async function TextDruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModulePage("texte");
  const { perms } = await requireUser();
  const id = (await params).id;
  const out = await exportMarkdown(await getDb(), perms, id);
  if (!out) notFound();
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/texte/${id}`}>Zurück zum Text</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow="Text" title={out.title} stamp={`Stand ${stamp.format(new Date())} Uhr`} />
        {out.markdown ? <Markdown>{out.markdown}</Markdown> : <p className="text-sm">Der Text ist noch leer.</p>}
      </main>
    </div>
  );
}
