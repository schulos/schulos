import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ } from "@/core/time";
import { openReports } from "@/modules/foren/moderation";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { HidePost } from "../thema/[id]/moderation-client";
import { DismissReport } from "./dismiss";

export const metadata: Metadata = { title: "Gemeldete Beiträge" };

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export default async function MeldungenPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "foren.moderate") && perms.leaderOf.size === 0) notFound();
  const reports = await openReports(await getDb(), perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Foren" title="Gemeldete Beiträge" />
      {reports.length === 0 ? (
        <EmptyState title="Keine offenen Meldungen" />
      ) : (
        <ul aria-label="Offene Meldungen" className="flex flex-col gap-3">
          {reports.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
              <p className="text-sm text-muted">
                {r.forumName} ·{" "}
                <Link href={`/foren/thema/${r.topicId}#${r.postId}`} className="font-medium text-accent-ink hover:underline">
                  {r.topicTitle}
                </Link>{" "}
                · gemeldet {fmt.format(r.createdAt)} von {r.reporterName ?? "Gelöschtes Konto"}
              </p>
              <p>
                <span className="font-medium">Grund:</span> {r.reason}
              </p>
              <blockquote className="line-clamp-4 rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">{r.body}</blockquote>
              <div className="flex flex-wrap items-start gap-2">
                {!r.hiddenAt && <HidePost topicId={r.topicId} postId={r.postId} />}
                <DismissReport id={r.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
