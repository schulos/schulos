import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import { addRoomPhotoAction, deleteRoomPhotoAction, setCoverPhotoAction, setPhotoCaptionAction } from "@/modules/verwaltung/raum-daten-actions";
import { canEditRoomInfo } from "@/modules/verwaltung/raum-rechte";
import { ROOM_PHOTOS_MAX, ROOM_PHOTO_CAPTION_MAX, ROOM_PHOTO_MAX_MB, listRoomPhotos } from "@/modules/verwaltung/raumfotos";
import { getRoom } from "@/modules/verwaltung/rooms";
import { roomPhotoSrc, roomTitle } from "@/ui/raum-steckbrief";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { CaptionForm, DeletePhotoButton, PhotoUploadForm } from "./photo-forms";

export const metadata: Metadata = { title: "Fotos bearbeiten" };

/** RS-04: Fotos eines Raums pflegen (höchstens 8, ein Titelbild) – bis RS-06 mit `verwaltung.school` (`canEditRoomInfo`). */
export default async function RaumFotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const id = decodeURIComponent((await params).id);
  if (!canEditRoomInfo(perms, id)) notFound();
  const db = await getDb();
  const room = await getRoom(db, id);
  if (!room) notFound();
  const photos = await listRoomPhotos(db, perms, room.id);
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Raumsteckbrief · Fotos"
        title={roomTitle(room)}
        actions={
          <Button asChild>
            <Link href={`${roomHref(room.id)}#fotos`}>Zum Steckbrief</Link>
          </Button>
        }
      />
      <p className="text-sm text-muted">
        Das Titelbild sehen alle Angemeldeten (auch Schüler:innen und Eltern), die übrigen Fotos nur Beschäftigte.{" "}
        {photos.length} von {ROOM_PHOTOS_MAX} Fotos.
      </p>
      {photos.length < ROOM_PHOTOS_MAX ? (
        <Card>
          <CardHeader title="Foto hochladen" />
          <PhotoUploadForm action={addRoomPhotoAction.bind(null, room.id)} maxMb={ROOM_PHOTO_MAX_MB} captionMax={ROOM_PHOTO_CAPTION_MAX} />
        </Card>
      ) : (
        <p role="status" className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
          Der Raum hat schon {ROOM_PHOTOS_MAX} Fotos. Für ein neues Foto bitte erst eines löschen.
        </p>
      )}
      <Card aria-labelledby="vorhanden">
        <CardHeader title={<span id="vorhanden">Vorhandene Fotos</span>} />
        {photos.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Fotos.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {photos.map((p, i) => {
              const label = `Foto ${i + 1}${p.caption ? ` „${p.caption}“` : ""}`;
              return (
                <li key={p.id} className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start">
                  {/* eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, keine Bildoptimierung */}
                  <img src={roomPhotoSrc(p.id, true)} alt={p.caption ?? `Foto ${i + 1}`} className="aspect-[4/3] w-full rounded-lg border border-border bg-surface-2 object-cover sm:w-48" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">Foto {i + 1}</span>
                      <span className="text-muted">
                        {p.width} × {p.height} px
                      </span>
                      {p.isCover && <Badge tone="soft">Titelbild</Badge>}
                    </div>
                    <CaptionForm action={setPhotoCaptionAction.bind(null, room.id, p.id)} caption={p.caption ?? ""} name={`Bildunterschrift ${label}`} captionMax={ROOM_PHOTO_CAPTION_MAX} />
                    <div className="flex flex-wrap gap-2">
                      {!p.isCover && (
                        <form action={setCoverPhotoAction.bind(null, room.id, p.id)}>
                          <Button type="submit" size="sm" aria-label={`${label} als Titelbild`}>
                            Als Titelbild
                          </Button>
                        </form>
                      )}
                      <DeletePhotoButton action={deleteRoomPhotoAction.bind(null, room.id, p.id)} label={label} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}
