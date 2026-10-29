import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ChevronLeft, ChevronRight, Pencil, Printer, Wrench } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, isoWeek, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { canEditRoomInfo, canMaintainAllRooms, roomProfile } from "@/modules/verwaltung/raumsteckbrief";
import { HISTORY_LIMIT, responsiblesFor, roomHistory } from "@/modules/verwaltung/raumverantwortliche";
import { listRoomLayouts } from "@/modules/verwaltung/raumlayout";
import { renewRoomCodeAction } from "@/modules/verwaltung/gebaeude-actions";
import { roomCode } from "@/modules/verwaltung/tuer-qr";
import { labelUrl } from "@/core/etiketten/qr";
import { RenewQrButton } from "./tuer-qr-renew";
import { capacityHint } from "@/core/raumlayout-raster";
import { LayoutGrid } from "@/ui/raumlayout";
import { InfoList, PhotoGallery, RoomBanners, RoomCover, RoomFacts, WeekGrid, fmtDay, roomTitle } from "@/ui/raum-steckbrief";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Raumsteckbrief" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const reported = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const changedAt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

/**
 * RS-02 Raumsteckbrief: für alle Angemeldeten, Inhalte je Sicht gefiltert (Service `roomProfile`). Kein Modul-Layout –
 * Räume sind Kernstammdaten; Abschnitte aus abschaltbaren Modulen erscheinen nur, wenn das Modul an ist.
 * RS-04: Titelbild im Kopf (alle), Galerie als Karte (Beschäftigte); RS-05: Ausstattung mit Menge im Kopf (alle).
 * RS-06: Karte „Verantwortliche“ (nur Beschäftigte) und „Änderungen“ aus dem Audit (nur Pflegende) im unteren Raster.
 * RS-08: Karte „Raumlayout“ (nur Beschäftigte) mit dem Standard-Layout, Link auf alle Layouts bzw. den Editor.
 */
export default async function RaumSteckbriefPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ woche?: string; gespeichert?: string; qr?: string }> }) {
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
  const canEditInfo = await canEditRoomInfo(db, perms, room.id);
  const canManageResponsibles = canMaintainAllRooms(perms);
  // RS-06: Verantwortliche sehen nur Beschäftigte, die Historie nur Pflegende (Recht oder Verantwortung für diesen Raum)
  const [responsibles, history, adressbuch, layouts, qrCode] = await Promise.all([
    responsiblesFor(db, perms, room.id),
    canEditInfo ? roomHistory(db, perms, room.id) : Promise.resolve(null),
    moduleOn("adressbuch"),
    // RS-08: Layouts nur für Beschäftigte (null für Schüler:innen/Eltern)
    listRoomLayouts(db, perms, room.id),
    // RS-11: Tür-QR nur für Pflegende (sonst null)
    canEditInfo ? roomCode(db, perms, room.id) : Promise.resolve(null),
  ]);
  const mainLayout = layouts?.[0] ?? null;
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {profile.cover && <RoomCover cover={profile.cover} roomId={room.id} className="sm:w-64 sm:shrink-0" />}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <RoomFacts room={room} />
            {canEditInfo && (
              <p className="text-sm">
                <Link href={`/raeume/${enc}/ausstattung`} className="font-medium text-accent-ink hover:underline">
                  Ausstattung bearbeiten
                </Link>
              </p>
            )}
          </div>
        </div>
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
        {profile.photos && (
          <Card aria-labelledby="fotos" className="scroll-mt-20">
            <CardHeader title={<span id="fotos">Fotos</span>} action={canEditInfo ? { href: `/raeume/${enc}/fotos`, label: "Fotos bearbeiten" } : undefined} />
            <PhotoGallery photos={profile.photos} roomId={room.id} />
          </Card>
        )}
        {layouts && (
          <Card aria-labelledby="raumlayout" className="scroll-mt-20 lg:col-span-2">
            <CardHeader
              title={<span id="raumlayout">Raumlayout</span>}
              action={layouts.length > 0 || canEditInfo ? { href: `/raeume/${enc}/layout`, label: canEditInfo ? "Layouts bearbeiten" : "Alle Layouts" } : undefined}
            />
            {mainLayout ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted">
                  {mainLayout.name} · {mainLayout.seats} {mainLayout.seats === 1 ? "Platz" : "Plätze"} · {mainLayout.examSeats} Prüfungsplätze
                  {layouts.length > 1 && ` · weitere: ${layouts.slice(1).map((l) => l.name).join(", ")}`}
                </p>
                <LayoutGrid rows={mainLayout.rows} cols={mainLayout.cols} cells={mainLayout.cells} caption={`Raumlayout ${mainLayout.name}, Raum ${room.id}`} />
                {capacityHint(mainLayout.seats, room.capacity) && <p className="text-xs text-muted">{capacityHint(mainLayout.seats, room.capacity)}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted">Noch kein Layout eingetragen.</p>
            )}
          </Card>
        )}
        {responsibles && (
          <Card aria-labelledby="verantwortliche" className="scroll-mt-20">
            <CardHeader
              title={<span id="verantwortliche">Verantwortliche</span>}
              action={canManageResponsibles ? { href: `/raeume/${enc}/verantwortliche`, label: "Verantwortliche bearbeiten" } : undefined}
            />
            {responsibles.length === 0 ? (
              <p className="text-sm text-muted">Niemand eingetragen.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {responsibles.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {adressbuch && r.kind === "person" ? (
                      <Link href={`/adressbuch/person/${encodeURIComponent(r.refId)}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.name}</span>
                    )}
                    {r.kind === "gruppe" && <Badge tone="neutral">Gruppe</Badge>}
                    {r.note && <span className="text-muted">{r.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {canEditInfo && room.active && (
          <Card aria-labelledby="tuer-qr" className="scroll-mt-20">
            <CardHeader title={<span id="tuer-qr">Tür-QR</span>} />
            {sp.qr === "neu" && (
              <p role="status" className="mb-3 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
                Neuer Code erzeugt – der alte gilt nicht mehr. Bitte das Türschild neu drucken.
              </p>
            )}
            <p className="text-sm text-muted">
              Der QR-Code am Türschild führt nach der Anmeldung hierher; ohne Anmeldung zeigt er nur die Anmeldeseite.
            </p>
            <p className="mt-2 text-sm break-all" data-testid="tuer-qr-url">
              {qrCode ? <span className="font-mono">{labelUrl("raum", qrCode)}</span> : "Noch kein Code – er entsteht beim ersten Druck."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link href={`/druck/tuerschilder?raum=${enc}`}>
                  <Printer aria-hidden /> Türschild drucken
                </Link>
              </Button>
              {qrCode && <RenewQrButton action={renewRoomCodeAction.bind(null, room.id)} roomId={room.id} />}
            </div>
          </Card>
        )}
        {history && (
          <Card aria-labelledby="aenderungen" className="scroll-mt-20">
            <CardHeader title={<span id="aenderungen">Änderungen</span>} />
            {history.length === 0 ? (
              <p className="text-sm text-muted">Noch keine Änderungen protokolliert.</p>
            ) : (
              <ol className="flex flex-col gap-2 text-sm">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-col">
                    <span>
                      <span className="font-medium">{h.label}</span>
                      {h.detail && <span className="text-muted"> · {h.detail}</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {changedAt.format(h.at)} · {h.actor}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-xs text-muted">Aus dem Protokoll, die letzten {HISTORY_LIMIT} Vorgänge – ohne die Texte der Infofelder.</p>
          </Card>
        )}
      </div>
    </main>
  );
}
