import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import { addResponsibleAction, removeResponsibleAction } from "@/modules/verwaltung/raum-daten-actions";
import { canMaintainAllRooms } from "@/modules/verwaltung/raum-rechte";
import { RESPONSIBLES_MAX, RESPONSIBLE_NOTE_MAX, listResponsibles, responsibleCandidates } from "@/modules/verwaltung/raumverantwortliche";
import { getRoom } from "@/modules/verwaltung/rooms";
import { roomTitle } from "@/ui/raum-steckbrief";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { AddResponsibleForm, RemoveResponsibleButton } from "./responsible-forms";

export const metadata: Metadata = { title: "Verantwortliche bearbeiten" };

/**
 * RS-06: Raumverantwortliche eintragen und entfernen – Recht „Raumdaten pflegen“ bzw. `verwaltung.school`. Verantwortliche selbst
 * pflegen ihren Raum (Infofelder, Fotos, Ausstattung), tragen aber keine weiteren Verantwortlichen ein.
 */
export default async function RaumVerantwortlichePage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!canMaintainAllRooms(perms)) notFound();
  const id = decodeURIComponent((await params).id);
  const db = await getDb();
  const room = await getRoom(db, id);
  if (!room) notFound();
  const [list, candidates] = await Promise.all([listResponsibles(db, room.id), responsibleCandidates(db)]);
  const taken = new Set(list.map((r) => `${r.kind === "person" ? "u" : "g"}:${r.refId}`));
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Raumsteckbrief · Verantwortliche"
        title={roomTitle(room)}
        actions={
          <Button asChild>
            <Link href={`${roomHref(room.id)}#verantwortliche`}>Zum Steckbrief</Link>
          </Button>
        }
      />
      <p className="text-sm text-muted">
        Verantwortliche (z. B. die Fachraumleitung) pflegen Infofelder, Fotos und Ausstattung dieses Raums – nicht Name, Art, Plätze oder
        Sperren. Bei einer Gruppe gilt das für ihre Beschäftigten. Wer verantwortlich ist, sehen nur Beschäftigte.
      </p>
      <Card aria-labelledby="eingetragen">
        <CardHeader title={<span id="eingetragen">Eingetragen</span>} />
        {list.length === 0 ? (
          <p className="text-sm text-muted">Noch niemand eingetragen.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {list.map((r) => (
              <li key={r.id} aria-label={r.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0">
                <span className="font-medium">{r.name}</span>
                <Badge tone="neutral">{r.kind === "person" ? "Person" : "Gruppe"}</Badge>
                {!r.active && <Badge tone="warn">{r.kind === "person" ? "Konto gesperrt" : "archiviert"}</Badge>}
                {r.note && <span className="text-sm text-muted">{r.note}</span>}
                <span className="ml-auto">
                  <RemoveResponsibleButton action={removeResponsibleAction.bind(null, room.id, r.id)} label={r.name} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {list.length < RESPONSIBLES_MAX ? (
        <Card>
          <CardHeader title="Verantwortliche eintragen" />
          <AddResponsibleForm
            action={addResponsibleAction.bind(null, room.id)}
            people={candidates.people.filter((p) => !taken.has(`u:${p.id}`))}
            groups={candidates.groups.filter((g) => !taken.has(`g:${g.id}`))}
            noteMax={RESPONSIBLE_NOTE_MAX}
          />
        </Card>
      ) : (
        <p role="status" className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
          Höchstens {RESPONSIBLES_MAX} Verantwortliche je Raum.
        </p>
      )}
    </main>
  );
}
