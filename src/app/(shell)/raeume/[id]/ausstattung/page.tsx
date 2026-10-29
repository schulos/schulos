import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import { addRoomEquipmentAction, saveRoomEquipmentAction } from "@/modules/verwaltung/raum-daten-actions";
import { canEditRoomInfo, canManageInfoFields } from "@/modules/verwaltung/raum-rechte";
import { EQUIPMENT_NAME_MAX, EQUIPMENT_QUANTITY_MAX, listEquipmentTypes, roomEquipment } from "@/modules/verwaltung/raumausstattung";
import { getRoom } from "@/modules/verwaltung/rooms";
import { roomTitle } from "@/ui/raum-steckbrief";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { AddEquipmentForm, QuantitiesForm } from "./equipment-forms";

export const metadata: Metadata = { title: "Ausstattung bearbeiten" };

/** RS-05: Ausstattung eines Raums mit Menge pflegen – Katalog wächst beim Eintragen; Recht „Raumdaten pflegen“ bzw. Raumverantwortliche (RS-06). */
export default async function RaumAusstattungPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const id = decodeURIComponent((await params).id);
  const db = await getDb();
  if (!(await canEditRoomInfo(db, perms, id))) notFound();
  const room = await getRoom(db, id);
  if (!room) notFound();
  const [items, catalog] = await Promise.all([roomEquipment(db, room.id), listEquipmentTypes(db)]);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Raumsteckbrief · Ausstattung"
        title={roomTitle(room)}
        actions={
          <Button asChild>
            <Link href={roomHref(room.id)}>Zum Steckbrief</Link>
          </Button>
        }
      />
      <p className="text-sm text-muted">Die Ausstattung sehen alle Angemeldeten im Steckbrief und in der Raumsuche.</p>
      <Card>
        <CardHeader title="Ausstattung eintragen" />
        <AddEquipmentForm action={addRoomEquipmentAction.bind(null, room.id)} catalog={catalog.map((t) => t.name)} nameMax={EQUIPMENT_NAME_MAX} quantityMax={EQUIPMENT_QUANTITY_MAX} />
      </Card>
      <Card aria-labelledby="vorhanden">
        <CardHeader title={<span id="vorhanden">Im Raum</span>} />
        {items.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Ausstattung eingetragen.</p>
        ) : (
          <QuantitiesForm action={saveRoomEquipmentAction.bind(null, room.id)} items={items} quantityMax={EQUIPMENT_QUANTITY_MAX} />
        )}
      </Card>
      {canManageInfoFields(perms) && (
        <p className="text-sm text-muted">
          Doppelte oder falsch geschriebene Einträge räumt die Verwaltung im{" "}
          <Link href="/verwaltung/stammdaten/raeume/ausstattung" className="font-medium text-accent-ink hover:underline">
            Ausstattungskatalog
          </Link>{" "}
          auf (umbenennen, zusammenführen).
        </p>
      )}
    </main>
  );
}
