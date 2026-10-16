import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { devMailEnabled, listOutbox } from "@/core/mail";
import { hasPermission } from "@/core/permissions";
import { TZ } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Mail-Warteschlange (Entwicklung)" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "medium", timeZone: TZ });

/**
 * Transaktionsmails lesen, ohne SMTP (P4-30): nur in der Entwicklung bzw. mit SCHULOS_DEV_MAIL=1 (E2E-Server), nur für
 * Konten mit „verwaltung.system“. So kann Playwright Bestätigungslinks lesen.
 */
export default async function DevMailPage() {
  const { perms } = await requireUser();
  if (!devMailEnabled() || !hasPermission(perms, "verwaltung.system")) notFound();
  const rows = await listOutbox(await getDb());
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Entwicklung" title="Mail-Warteschlange" />
      <p className="max-w-3xl text-sm text-muted">
        Ohne SMTP bleiben Transaktionsmails hier liegen. Diese Seite gibt es nur in der Entwicklung und im E2E-Lauf.
      </p>
      {rows.length === 0 && <EmptyState title="Keine Mails" />}
      <ul className="flex flex-col gap-4">
        {rows.map((m) => (
          <li key={m.id}>
            <Card aria-label={`Mail ${m.subject || m.purpose}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>{m.purpose}</Badge>
                {m.sentAt ? <Badge tone="success">gesendet</Badge> : m.failedAt ? <Badge tone="danger">gescheitert</Badge> : <Badge tone="warn">wartet</Badge>}
                <span className="text-muted">{fmt.format(m.createdAt)}</span>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">An</dt>
                <dd data-testid="mail-to">{m.to}</dd>
                <dt className="text-muted">Betreff</dt>
                <dd data-testid="mail-subject">{m.subject}</dd>
              </dl>
              <pre data-testid="mail-text" className="mt-3 rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap">
                {m.text}
              </pre>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
