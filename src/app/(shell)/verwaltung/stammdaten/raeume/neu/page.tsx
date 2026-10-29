import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { createRoomAction } from "@/modules/verwaltung/room-actions";
import { placeOptions } from "@/modules/verwaltung/gebaeude-etagen";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { RoomForm } from "../room-form";

export const metadata: Metadata = { title: "Raum anlegen" };

export default async function NeuerRaumPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.school")) notFound();
  const buildings = await placeOptions(await getDb());
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Stammdaten" title="Raum anlegen" />
      <Card>
        <RoomForm action={createRoomAction} buildings={buildings} submitLabel="Anlegen" />
      </Card>
    </main>
  );
}
