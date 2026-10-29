import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, History, Pencil, Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { ATTACHMENT_ACCEPT, ATTACHMENT_FORMATS, ATTACHMENT_MAX_MB, ATTACHMENTS_MAX, INLINE_MIMES, listAttachments } from "@/modules/hilfe/attachments";
import { canEditAll, canEditPage, canManage, getPage, reviewDueOn, reviewMonths } from "@/modules/hilfe/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { AttachmentUploadForm, DeleteAttachment } from "./attachment-forms";
import { DeletePage, MoveButtons, ReviewButton } from "./page-actions";

export const metadata: Metadata = { title: "Handbuch" };

const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "UTC" });
const fmtDay = (ymd: string) => day.format(new Date(`${ymd}T12:00:00Z`));
const INLINE = INLINE_MIMES;
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
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
  const attachments = await listAttachments(db, perms, page.id);
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
        {(attachments.length > 0 || editable) && (
          <section aria-labelledby="anhaenge" className="flex flex-col gap-3 border-t border-border pt-4">
            <h2 id="anhaenge" className="text-base font-semibold">
              Anhänge
            </h2>
            {attachments.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {attachments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                    <a
                      href={`/api/hilfe/anhang/${a.id}${INLINE.has(a.mime) ? "?inline=1" : ""}`}
                      {...(INLINE.has(a.mime) ? { target: "_blank", rel: "noopener noreferrer" } : { download: a.name })}
                      className="inline-flex min-h-11 items-center gap-2 text-accent-ink hover:underline"
                    >
                      <FileText className="size-4" aria-hidden /> {a.name}
                      <span className="text-sm text-muted">({fmtSize(a.size)})</span>
                    </a>
                    {editable && <DeleteAttachment id={a.id} name={a.name} />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Noch keine Anhänge.</p>
            )}
            {editable && attachments.length < ATTACHMENTS_MAX && (
              <AttachmentUploadForm pageId={page.id} accept={ATTACHMENT_ACCEPT} formats={ATTACHMENT_FORMATS} maxMb={ATTACHMENT_MAX_MB} />
            )}
            {editable && attachments.length >= ATTACHMENTS_MAX && <p className="text-sm text-muted">Mehr als {ATTACHMENTS_MAX} Anhänge je Seite sind nicht möglich.</p>}
          </section>
        )}
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
            {editor && (
              <Button asChild size="sm" variant="ghost">
                <Link href={`/hilfe/${page.slug}/verlauf`}>
                  <History aria-hidden /> Verlauf
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
