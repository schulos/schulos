import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { dateLabel, getSessionList } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { PageHeader } from "@schulos/ui/misc";
import { AttendanceList } from "./attendance-list";

export const metadata: Metadata = { title: "Ganztag: Anwesenheitsliste" };

const STATE_TEXT = {
  zukunft: "Die Liste lässt sich erst am Tag des Termins erfassen.",
  ausgefallen: "Dieser Termin fällt aus – es gibt nichts zu erfassen.",
  abgelaufen: "Die Frist zum Nachtragen ist vorbei. Änderungen nur noch über die Verwaltung des Ganztags.",
} as const;

export default async function TerminPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const list = await getSessionList(await getDb(), perms, decodeURIComponent(id));
  if (!list) notFound();
  const { session, group, counts } = list;

  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/ganztag/gruppe/${group.id}`}>
          <ArrowLeft aria-hidden /> {group.name}
        </Link>
      </Button>
      <PageHeader eyebrow={group.name} title={`${dateLabel(session.date)}, ${session.startsAt}–${session.endsAt}`} />
      <p className="flex flex-wrap gap-2" role="status" aria-label="Stand der Liste">
        <Badge tone="success">{counts.anwesend} anwesend</Badge>
        <Badge tone="danger">{counts.fehlt} fehlt</Badge>
        <Badge tone="warn">{counts.verspaetet} verspätet</Badge>
        <Badge>{counts.offen} offen</Badge>
      </p>
      {list.state !== "offen" && <p className="rounded-xl border border-border bg-surface-2 p-3 text-sm">{STATE_TEXT[list.state]}</p>}
      {list.rows.length === 0 ? (
        <p className="text-muted">Die Gruppe hat noch keine Teilnehmenden.</p>
      ) : (
        <AttendanceList sessionId={session.id} rows={list.rows} allPresent={session.allPresent} editable={list.state === "offen"} />
      )}
      <p className="text-xs text-muted">
        Nur anwesend, fehlt oder verspätet – keine Gründe eintragen. Entschuldigungen laufen über die Abwesenheiten; liegt dort eine Krankmeldung oder Beurlaubung
        vor, steht „entschuldigt“ an der Zeile.
        {list.mandatory && " Verpflichtendes Angebot: unentschuldigtes Fehlen geht abends als Hinweis an die Klassenleitung (kein Eintrag ins Klassenbuch)."}
      </p>
    </main>
  );
}
