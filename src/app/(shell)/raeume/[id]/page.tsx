import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ChevronLeft, ChevronRight, Pencil, Printer, Wrench } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, isoWeek, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { canEditRoomInfo, roomProfile } from "@/modules/verwaltung/raumsteckbrief";
import { InfoList, RoomBanners, RoomFacts, WeekGrid, fmtDay, roomTitle } from "@/ui/raum-steckbrief";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Raumsteckbrief" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const reported = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });

/**
 * RS-02 Raumsteckbrief: für alle Angemeldeten, Inhalte je Sicht gefiltert (Service `roomProfile`). Kein Modul-Layout –
 * Räume sind Kernstammdaten; Abschnitte aus abschaltbaren Modulen erscheinen nur, wenn das Modul an ist.
 * Platz für RS-04 (Titelbild im Kopf, Galerie), RS-05 (Ausstattung mit Menge statt der Badges) und RS-06 (Verantwortliche).
 */
export default async function RaumSteckbriefPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ woche?: string; gespeichert?: string }> }) {
  const { perms } = await requireUser();
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  // am Wochenende gleich die kommende Woche (wie Stundenplan und Tagesleiste)
  const thisWeek = weekdayMon0(today) >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const monday = YMD.test(sp.woche ?? "") ? mondayOf(sp.woche!) : thisWeek;
  const [stundenplan, gebaeude, buchungen] = await Promise.all([moduleOn("stundenplan"), moduleOn("gebaeude"), moduleOn("buchungen")]);
  const profile = await roomProfile(db, perms, id, { today, monday, modules: { stundenplan, gebaeude, buchungen } });
  if (!profile) notFound();
  const { room, audience, week, defects, inspections } = profile;
  const staffView = audience === "personal";
  const enc = encodeURIComponent(room.id);
  const canReport = gebaeude && hasPermission(perms, "gebaeude.report") && room.active;
  const canBook = buchungen && hasPermission(perms, "buchungen.book") && profile.bookingResourceId !== null && room.active;
  const canEdit = hasPermission(perms, "verwaltung.school");
  const canEditInfo = canEditRoomInfo(perms, room.id);
  const weekHref = (m: string) => `/raeume/${enc}?woche=${m}#belegung`;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Raumsteckbrief"
        title={roomTitle(room)}
        actions={
          <>
            {canReport && (
              <Button asChild>
                <Link href={`/gebaeude/melden?raum=${enc}`}>
                  <Wrench aria-hidden /> Mangel melden
                </Link>
              </Button>
            )}
            {canBook && (
              <Button asChild variant="primary">
                <Link href={`/buchungen?ressource=${profile.bookingResourceId}&woche=${monday}`}>
                  <CalendarPlus aria-hidden /> Raum buchen
                </Link>
              </Button>
            )}
            {canEdit && (
              <Button asChild>
                <Link href={`/verwaltung/stammdaten/raeume/${enc}`} aria-label={`Raum ${room.id} bearbeiten`}>
                  <Pencil aria-hidden /> Bearbeiten
                </Link>
              </Button>
            )}
            <Button asChild variant="ghost">
              <Link href={`/druck/raum/${enc}?woche=${monday}`}>
                <Printer aria-hidden /> Drucken
              </Link>
            </Button>
          </>
        }
      />
      <RoomBanners profile={profile} />
      {sp.gespeichert && (
        <p role="status" className="rounded-lg bg-success-soft px-4 py-2 text-sm text-success">
          Infofelder gespeichert.
        </p>
      )}

      <Card aria-labelledby="kopf">
        <CardHeader title={<span id="kopf">Überblick</span>} action={{ href: "/raeume", label: "Alle Räume" }} />
        {/* RS-04: Titelbild links neben den Kopfdaten */}
        <RoomFacts room={room} />
      </Card>

      {week && (
        <section aria-labelledby="belegung" className="flex scroll-mt-20 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <h2 id="belegung" className="mr-2 font-display text-xl font-bold">
              Belegung
            </h2>
            <Button asChild variant="ghost" size="icon">
              <Link href={weekHref(addDays(monday, -7))} aria-label="Vorige Woche">
                <ChevronLeft aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="icon">
              <Link href={weekHref(addDays(monday, 7))} aria-label="Nächste Woche">
                <ChevronRight aria-hidden />
              </Link>
            </Button>
            <span className="text-sm text-muted">
              KW {isoWeek(monday)} · {fmtDay(monday)} – {fmtDay(addDays(monday, 4))}
            </span>
            {monday !== thisWeek && (
              <Link href={`/raeume/${enc}#belegung`} className="ml-2 text-sm font-medium text-accent-ink hover:underline">
                diese Woche
              </Link>
            )}
          </div>
          {!staffView && <p className="text-sm text-muted">Die Belegung zeigt nur, ob der Raum frei oder belegt ist.</p>}
          <WeekGrid week={week} today={today} caption={`Belegung Raum ${room.id}, KW ${isoWeek(monday)}`} />
          {staffView && stundenplan && (
            <p className="text-sm">
              <Link href={`/stundenplan?raum=${enc}&woche=${monday}`} className="font-medium text-accent-ink hover:underline">
                Raumplan mit Vertretungen ansehen
              </Link>
            </p>
          )}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-labelledby="infofelder" className="scroll-mt-20">
          <CardHeader title={<span id="infofelder">Infofelder</span>} action={canEditInfo ? { href: `/raeume/${enc}/infofelder`, label: "Infofelder bearbeiten" } : undefined} />
          <InfoList info={profile.info} staffView={staffView} />
        </Card>

        {defects && (
          <Card aria-labelledby="maengel">
            <CardHeader title={<span id="maengel">Offene Mängel</span>} />
            {defects.length === 0 ? (
              <p className="text-sm text-muted">Keine offenen Meldungen zu diesem Raum.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {defects.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {d.canOpen ? (
                      <Link href={`/gebaeude/${d.id}`} className="font-medium hover:underline">
                        {d.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{d.title}</span>
                    )}
                    <span className="text-xs text-muted">
                      {d.number} · {d.category} · seit {reported.format(d.createdAt)}
                    </span>
                    <Badge tone={d.priority === "gefahr" ? "danger" : d.priority === "hoch" ? "warn" : "neutral"}>{d.statusLabel}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {inspections && inspections.length > 0 && (
          <Card aria-labelledby="pruefungen">
            <CardHeader title={<span id="pruefungen">Fällige Prüfungen</span>} action={{ href: "/gebaeude/pruefungen", label: "Alle Prüfungen" }} />
            <ul className="flex flex-col gap-2 text-sm">
              {inspections.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{i.typeName}</span>
                  <span className="text-xs text-muted">fällig {fmtDay(i.dueOn)}</span>
                  <Badge tone={i.state === "ueberfaellig" ? "danger" : "warn"}>{i.state === "ueberfaellig" ? "überfällig" : "bald fällig"}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {/* RS-05: Ausstattung mit Menge · RS-06: Raumverantwortliche und Kontakt, Historie für Pflegende */}
      </div>
    </main>
  );
}
