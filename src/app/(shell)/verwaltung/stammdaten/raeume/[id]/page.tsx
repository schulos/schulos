import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { deleteRoomAction, updateRoomAction } from "@/modules/verwaltung/room-actions";
import { getRoom, listRooms, roomUsage } from "@/modules/verwaltung/rooms";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { RoomForm } from "../room-form";

export const metadata: Metadata = { title: "Raum bearbeiten" };

export default async function RaumPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.school")) notFound();
  const id = decodeURIComponent((await params).id);
  const db = await getDb();
  const [room, all, usage] = await Promise.all([getRoom(db, id), listRooms(db), roomUsage(db, id)]);
  if (!room) notFound();
  const buildings = [...new Set(all.map((r) => r.building).filter((b): b is string => !!b))];
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Stammdaten · Raum" title={room.id === room.name ? room.id : `${room.id} – ${room.name}`} />
      <Card>
        <RoomForm
          key={room.id}
          action={updateRoomAction.bind(null, room.id)}
          deleteAction={deleteRoomAction.bind(null, room.id)}
          initial={{ ...room, code: room.id }}
          buildings={buildings}
          used={usage.get(room.id) ?? 0}
          submitLabel="Speichern"
        />
      </Card>
    </main>
  );
}
