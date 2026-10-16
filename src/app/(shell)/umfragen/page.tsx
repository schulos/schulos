import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { canCreate, listForParticipant, listOwn, type SurveyListItem, type SurveyStatus } from "@/modules/umfragen/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Umfragen" };

const fmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const TONE: Record<SurveyStatus, "neutral" | "success" | "soft"> = { geplant: "neutral", offen: "success", beendet: "soft" };

function Row({ s, mine }: { s: SurveyListItem; mine: boolean }) {
  return (
    <li>
      <Link href={`/umfragen/${s.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 hover:border-border-strong">
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">{s.title}</span>
          <span className="text-sm text-muted">
            {s.status === "geplant" ? `ab ${fmt.format(s.opensAt)}` : `bis ${fmt.format(s.closesAt)}`} · {s.anonymous ? "anonym" : "namentlich"}
            {mine && ` · ${s.responses} ${s.responses === 1 ? "Antwort" : "Antworten"}`}
          </span>
        </span>
        {mine ? <Badge tone={TONE[s.status]}>{s.status}</Badge> : s.participated ? <Badge tone="success">teilgenommen</Badge> : <Badge tone="soft">offen</Badge>}
      </Link>
    </li>
  );
}

export default async function UmfragenPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [open, own] = await Promise.all([listForParticipant(db, perms), listOwn(db, perms)]);
  const create = canCreate(perms);

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Umfragen"
        actions={
          create && (
            <Button asChild variant="primary">
              <Link href="/umfragen/neu">
                <Plus aria-hidden /> Umfrage anlegen
              </Link>
            </Button>
          )
        }
      />
      <section aria-labelledby="fuer-mich" className="flex flex-col gap-3">
        <h2 id="fuer-mich" className="font-display text-xl font-bold">
          Für mich
        </h2>
        {open.length === 0 ? (
          <EmptyState title="Gerade keine offenen Umfragen" />
        ) : (
          <ul className="flex flex-col gap-2">
            {open.map((s) => (
              <Row key={s.id} s={s} mine={false} />
            ))}
          </ul>
        )}
      </section>
      {(create || own.length > 0) && (
        <section aria-labelledby="eigene" className="flex flex-col gap-3">
          <h2 id="eigene" className="font-display text-xl font-bold">
            Meine Umfragen
          </h2>
          {own.length === 0 ? (
            <EmptyState title="Noch keine Umfragen angelegt" />
          ) : (
            <ul className="flex flex-col gap-2">
              {own.map((s) => (
                <Row key={s.id} s={s} mine />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
