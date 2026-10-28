import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { getPage } from "@/modules/hilfe/service";
import { Button } from "@schulos/ui/button";
import { Markdown } from "@schulos/ui/markdown";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Handbuchseite drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** HB-02: Druckansicht bzw. PDF (über „Drucken“ → „Als PDF speichern“) – nur Seiten, die die Person sehen darf. */
export default async function HilfeDruckPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireModulePage("hilfe");
  const { perms } = await requireUser();
  const page = await getPage(await getDb(), perms, decodeURIComponent((await params).slug));
  if (!page) notFound();
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/hilfe/${page.slug}`}>Zurück zur Seite</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf
          eyebrow={`Handbuch · ${page.sectionTitle}`}
          title={page.title}
          stamp={`Stand ${stamp.format(page.updatedAt)}${page.contactName ? ` · Ansprechperson: ${page.contactName}` : ""}`}
        />
        {page.body ? <Markdown>{page.body}</Markdown> : <p className="text-sm">Diese Seite hat noch keinen Text.</p>}
      </main>
    </div>
  );
}
