import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil, Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { canEditAll, canEditPage, canManage, getPage, reviewDueOn, reviewMonths } from "@/modules/hilfe/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { DeletePage, MoveButtons, ReviewButton } from "./page-actions";

export const metadata: Metadata = { title: "Handbuch" };

const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "UTC" });
const fmtDay = (ymd: string) => day.format(new Date(`${ymd}T12:00:00Z`));
const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });

export default async function HilfeSeitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { perms } = await requireUser();
  const slug = decodeURIComponent((await params).slug);
  const db = await getDb();
  const page = await getPage(db, perms, slug);
  if (!page) notFound();
  const editable = canEditPage(perms, page);
  const editor = canEditAll(perms);
  const due = editable ? reviewDueOn(page.reviewedOn, await reviewMonths(db)) : null;
  const overdue = due !== null && due <= toBerlinDate(new Date());

  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <nav aria-label="Brotkrumen" className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
        <Link href="/hilfe" className="inline-flex items-center gap-1.5 hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> Handbuch
        </Link>
        <span aria-hidden>/</span>
        <span>{page.sectionTitle}</span>
      </nav>
      <Card className="gap-5 p-6 sm:p-8">
        {page.status === "entwurf" && (
          <p>
            <Badge tone="warn">Entwurf – nur für Pflegende und die Ansprechperson sichtbar</Badge>
          </p>
        )}
        <h1 className="font-display text-3xl font-bold tracking-tight">{page.title}</h1>
        {page.body ? <Markdown>{page.body}</Markdown> : <p className="text-muted">Diese Seite hat noch keinen Text.</p>}
        <footer className="flex flex-col gap-3 border-t border-border pt-4 text-sm text-muted">
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="font-medium text-ink">Ansprechperson</dt>
            <dd>{page.contactName ?? "keine"}</dd>
            <dt className="font-medium text-ink">Stand</dt>
            <dd>
              {stamp.format(page.updatedAt)}
              {page.updatedByName && ` · ${page.updatedByName}`}
            </dd>
            {editor && (
              <>
                <dt className="font-medium text-ink">Für</dt>
                <dd>{page.targets.length ? page.targets.join(", ") : "alle"}</dd>
              </>
            )}
            {due && (
              <>
                <dt className="font-medium text-ink">Überprüfung</dt>
                <dd className={overdue ? "font-semibold text-warn" : undefined}>
                  {overdue ? `fällig seit ${fmtDay(due)}` : `fällig am ${fmtDay(due)}`}
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link href={`/druck/hilfe/${page.slug}`}>
                <Printer aria-hidden /> Drucken
              </Link>
            </Button>
            {editable && (
              <Button asChild size="sm">
                <Link href={`/hilfe/${page.slug}/bearbeiten`}>
                  <Pencil aria-hidden /> Bearbeiten
                </Link>
              </Button>
            )}
            {editable && page.status === "veroeffentlicht" && <ReviewButton id={page.id} />}
            {editor && <MoveButtons id={page.id} />}
            {canManage(perms) && <DeletePage id={page.id} />}
          </div>
        </footer>
      </Card>
    </main>
  );
}
