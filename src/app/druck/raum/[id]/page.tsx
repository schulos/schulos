import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { roomHref } from "@/core/room-href";
import { TZ, addDays, isoWeek, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { roomProfile } from "@/modules/verwaltung/raumsteckbrief";
import { DruckKopf } from "@/ui/druck-kopf";
import { InfoList, RoomBanners, RoomCover, RoomFacts, WeekGrid, fmtDay, roomTitle } from "@/ui/raum-steckbrief";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Raumsteckbrief drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** RS-02: Druckansicht A4 des Steckbriefs – dieselbe Filterung wie die Seite (Mängel nicht im Aushang). */
export default async function RaumDruckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ woche?: string }> }) {
  const { perms } = await requireUser();
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  const thisWeek = weekdayMon0(today) >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(sp.woche ?? "") ? mondayOf(sp.woche!) : thisWeek;
  const stundenplan = await moduleOn("stundenplan");
  const profile = await roomProfile(await getDb(), perms, id, { today, monday, modules: { stundenplan, gebaeude: false, buchungen: false } });
  if (!profile) notFound();
  const { room, week } = profile;
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={roomHref(room.id)}>Zurück zum Steckbrief</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow="Raumsteckbrief" title={roomTitle(room)} stamp={`Stand ${stamp.format(new Date())}`} />
        <RoomBanners profile={profile} />
        <div className="flex items-start gap-4">
          {profile.cover && <RoomCover cover={profile.cover} roomId={room.id} className="w-48 shrink-0" />}
          <div className="min-w-0 flex-1">
            <RoomFacts room={room} />
          </div>
        </div>
        <section aria-labelledby="d-info" className="flex flex-col gap-2">
          <h2 id="d-info" className="text-base font-semibold">
            Infofelder
          </h2>
          <InfoList info={profile.info} staffView={profile.audience === "personal"} />
        </section>
        {week && (
          <section aria-labelledby="d-belegung" className="flex flex-col gap-2 break-inside-avoid">
            <h2 id="d-belegung" className="text-base font-semibold">
              Belegung KW {isoWeek(monday)} ({fmtDay(monday)} – {fmtDay(addDays(monday, 4))})
            </h2>
            <WeekGrid week={week} today={today} caption={`Belegung Raum ${room.id}, KW ${isoWeek(monday)}`} />
          </section>
        )}
      </main>
    </div>
  );
}
