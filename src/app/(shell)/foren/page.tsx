import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { hasPermission } from "@/core/permissions";
import { openReports } from "@/modules/foren/moderation";
import { listForums } from "@/modules/foren/service";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Foren" };

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export default async function ForenPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [forums, reports] = await Promise.all([listForums(db, perms), openReports(db, perms)]);
  const moderates = hasPermission(perms, "foren.moderate") || perms.leaderOf.size > 0;
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Kommunikation"
        title="Foren"
        actions={
          moderates && (
            <Link href="/foren/meldungen" className="text-sm font-medium text-accent-ink hover:underline">
              Gemeldete Beiträge ({reports.length})
            </Link>
          )
        }
      />
      {forums.length === 0 ? (
        <EmptyState title="Noch kein Forum">Foren gibt es für Gruppen, deren Leitung das Forum eingeschaltet hat.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {forums.map((f) => (
            <li key={f.key}>
              <Link href={`/foren/${f.key}`} className="flex h-full flex-col gap-1 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
                <span className="font-semibold">{f.name}</span>
                <span className="text-sm text-muted">
                  {f.topics} {f.topics === 1 ? "Thema" : "Themen"}
                  {f.lastPostAt && ` · zuletzt ${fmt.format(f.lastPostAt)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
