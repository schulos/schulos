import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { roomHref } from "@/core/room-href";
import { saveRoomInfoAction } from "@/modules/verwaltung/raum-info-actions";
import { INFO_VALUE_MAX, canEditRoomInfo, roomInfoForm } from "@/modules/verwaltung/raumsteckbrief";
import { getRoom } from "@/modules/verwaltung/rooms";
import { roomTitle } from "@/ui/raum-steckbrief";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { RoomInfoForm } from "./info-form";

export const metadata: Metadata = { title: "Infofelder bearbeiten" };

/** RS-03: Infofelder eines Raums pflegen – bis RS-06 mit `verwaltung.school` (`canEditRoomInfo`). */
export default async function RaumInfofelderPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const id = decodeURIComponent((await params).id);
  if (!canEditRoomInfo(perms, id)) notFound();
  const db = await getDb();
  const [room, fields] = await Promise.all([getRoom(db, id), roomInfoForm(db, id)]);
  if (!room) notFound();
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Raumsteckbrief · Infofelder" title={roomTitle(room)} />
      <Card>
        {fields.length === 0 ? (
          <p className="text-sm text-muted">Es sind noch keine Infofelder festgelegt.</p>
        ) : (
          <RoomInfoForm action={saveRoomInfoAction.bind(null, room.id)} fields={fields} backHref={roomHref(room.id)} maxLength={INFO_VALUE_MAX} />
        )}
      </Card>
      {hasPermission(perms, "verwaltung.school") && (
        <p className="text-sm text-muted">
          Welche Felder es gibt und wer sie sieht, legt die Verwaltung schulweit fest:{" "}
          <Link href="/verwaltung/stammdaten/raeume/infofelder" className="font-medium text-accent-ink hover:underline">
            Infofelder verwalten
          </Link>
          .
        </p>
      )}
    </main>
  );
}
