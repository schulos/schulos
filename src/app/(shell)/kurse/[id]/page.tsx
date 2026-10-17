import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { dueText, StatusBadge } from "@/modules/aufgaben/ui";
import gebaeude from "@/modules/gebaeude/manifest";
import kurse from "@/modules/kurse/manifest";
import notenbuchModule from "@/modules/notenbuch/manifest";
import { ownBookLinks, type OwnBookLink } from "@/modules/notenbuch/links";
import sitzplanModule from "@/modules/sitzplan/manifest";
import { canUseGroup, plansByGroup } from "@/modules/sitzplan/service";
import { courseHub, type CourseHub } from "@/modules/kurse/service";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader, SubjectBar } from "@schulos/ui/misc";
import { CourseAreas } from "./bereiche";
import { ConferenceLink } from "./konferenz";
import { QuickPolls } from "../../umfragen/quick-polls";

export const metadata: Metadata = { title: "Kursraum" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const CHANGE_LABEL = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung" } as const;

function MembersOnly() {
  return <p className="text-sm text-muted">Nur für Mitglieder der Gruppe sichtbar.</p>;
}

function Lessons({ hub }: { hub: CourseHub }) {
  const items = hub.lessons!.items!;
  const today = toBerlinDate(new Date());
  return (
    <Card aria-labelledby="stunden" className="lg:col-span-2">
      <CardHeader title={<span id="stunden">Nächste Stunden</span>} action={{ href: `/stundenplan?gruppe=${hub.group.id}`, label: "Wochenplan" }} />
      {items.length === 0 ? (
        <p className="text-sm text-muted">In den nächsten zwei Wochen keine Stunden.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <li key={`${s.lessonId}-${s.date}`} className="flex items-stretch gap-3 rounded-xl border border-border px-3 py-2">
              <SubjectBar color={s.color} className="h-auto w-1 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="text-sm font-semibold">
                  {s.date === today ? "Heute" : dayFmt.format(fromBerlinLocal(s.date))} · {s.periodNr}. Std
                </span>
                <span className={s.change?.kind === "cancel" ? "text-sm text-muted line-through" : "text-sm text-muted"}>
                  {s.subjectName} · {s.startsAt}–{s.endsAt}
                  {s.teacherCode && ` · ${s.change?.kind === "substitute" && s.change.substituteCode ? s.change.substituteCode : s.teacherCode}`}
                  {(s.change?.roomId ?? s.roomId) && ` · ${s.change?.roomId ?? s.roomId}`}
                </span>
              </span>
              {s.change && <Badge tone={s.change.kind === "cancel" ? "danger" : "warn"}>{CHANGE_LABEL[s.change.kind]}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Q5-02: zuletzt aufgegebene Hausaufgaben aus dem Klassenbuch */
function Homework({ hub }: { hub: CourseHub }) {
  const items = hub.homework!.items;
  const today = toBerlinDate(new Date());
  return (
    <Card aria-labelledby="hausaufgaben">
      <CardHeader title={<span id="hausaufgaben">Hausaufgaben</span>} />
      {!items ? (
        <MembersOnly />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">In den letzten drei Wochen keine Hausaufgaben eingetragen.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((h) => (
            <li key={h.entryId} className="flex items-stretch gap-3">
              <SubjectBar color={h.color} className="h-auto w-1 shrink-0" />
              <span className="flex min-w-0 flex-col leading-snug">
                <span className="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{h.homework}</span>
                <span className="text-xs text-muted">
                  {h.subjectName} · aufgegeben {dayFmt.format(fromBerlinLocal(h.givenOn))}
                  {h.due && ` · fällig ${h.due === today ? "heute" : dayFmt.format(fromBerlinLocal(h.due))}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Tasks({ hub }: { hub: CourseHub }) {
  const items = hub.tasks!.items!;
  return (
    <Card aria-labelledby="aufgaben">
      <CardHeader title={<span id="aufgaben">Offene Aufgaben</span>} action={{ href: "/aufgaben", label: "Alle" }} />
      {items.length === 0 ? (
        <p className="text-sm text-muted">Keine offenen Aufgaben.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((t) => (
            <li key={t.id}>
              <Link href={`/aufgaben/${t.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="truncate text-xs text-muted">
                    {dueText(t.dueAt)}
                    {t.submitted !== undefined && ` · ${t.submitted} abgegeben`}
                  </span>
                </span>
                {t.status && <StatusBadge status={t.status} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Events({ hub }: { hub: CourseHub }) {
  const items = hub.events!.items;
  return (
    <Card aria-labelledby="termine">
      <CardHeader title={<span id="termine">Termine</span>} action={items ? { href: "/kalender", label: "Kalender" } : undefined} />
      {!items ? (
        <MembersOnly />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Keine Termine in den nächsten vier Wochen.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((e) => (
            <li key={`${e.eventId}-${e.start.toISOString()}`} className="flex flex-col leading-tight">
              <span className="font-medium">{e.title}</span>
              <span className="text-sm text-muted">
                {dayFmt.format(e.start)}
                {!e.allDay && `, ${timeFmt.format(e.start)}–${timeFmt.format(e.end)}`}
                {e.location && ` · ${e.location}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Files({ hub }: { hub: CourseHub }) {
  const items = hub.files!.items;
  return (
    <Card aria-labelledby="ordner">
      <CardHeader
        title={<span id="ordner">Gruppenordner</span>}
        action={items ? { href: `/dateien?bereich=${encodeURIComponent(`group:${hub.group.id}`)}`, label: "Öffnen" } : undefined}
      />
      {!items ? (
        <MembersOnly />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Noch leer.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((f) => (
            <li key={f.id} className="flex items-baseline justify-between gap-3">
              <span className="truncate">
                {f.kind === "folder" && <span className="text-muted">Ordner · </span>}
                {f.name}
              </span>
              <span className="shrink-0 text-xs text-muted">{dayFmt.format(f.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Chat({ hub }: { hub: CourseHub }) {
  const { roomId, items } = hub.chat!;
  return (
    <Card aria-labelledby="chat">
      <CardHeader title={<span id="chat">Gruppenchat</span>} action={roomId ? { href: `/messenger/${roomId}`, label: "Zum Chat" } : undefined} />
      {!items ? (
        <MembersOnly />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Noch keine Nachrichten.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <li key={m.id} className="flex flex-col leading-tight">
              <span className="text-xs text-muted">
                {m.authorName ?? "System"} · {dayFmt.format(m.createdAt)}, {timeFmt.format(m.createdAt)}
              </span>
              <span className="line-clamp-2 text-sm">{m.body}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Forum({ hub }: { hub: CourseHub }) {
  const items = hub.forum!.items;
  return (
    <Card aria-labelledby="forum">
      <CardHeader title={<span id="forum">Forum</span>} action={items ? { href: `/foren/${hub.group.id}`, label: "Zum Forum" } : undefined} />
      {!items ? (
        <MembersOnly />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">Noch keine Themen.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((t) => (
            <li key={t.id}>
              <Link href={`/foren/thema/${t.id}`} className="flex items-baseline justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="truncate font-medium">{t.title}</span>
                <span className="shrink-0 text-xs text-muted">
                  {t.posts} · {dayFmt.format(t.lastPostAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** P5-03: Sitzpläne der Gruppe – nur für Lehrkräfte der Gruppe und Klassenleitung */
function SeatPlans({ groupId, plans }: { groupId: string; plans: { id: string; title: string }[] }) {
  return (
    <Card aria-labelledby="sitzplaene">
      <CardHeader title={<span id="sitzplaene">Sitzplan</span>} action={{ href: `/sitzplan?gruppe=${encodeURIComponent(groupId)}`, label: "Neuer Sitzplan" }} />
      {plans.length === 0 ? (
        <p className="text-sm text-muted">Noch kein Sitzplan. Nur Lehrkräfte der Gruppe sehen ihn.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {plans.map((p) => (
            <li key={p.id}>
              <Link href={`/sitzplan/${p.id}`} className="block rounded-xl px-2 py-2 font-medium hover:bg-surface-2">
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** P5-16: eigene Notenbücher zu dieser Lerngruppe (laufendes Schuljahr) – nur für Lehrkräfte, die das Buch führen; keine Noten */
function GradeBooks({ books }: { books: OwnBookLink[] }) {
  return (
    <Card aria-labelledby="notenbuecher">
      <header className="flex items-center justify-between gap-3">
        <h2 id="notenbuecher" className="text-base font-semibold">
          Notenbuch
        </h2>
        <Link href="/notenbuch" prefetch={false} className="text-sm font-medium text-accent-ink hover:underline">
          Alle Notenbücher
        </Link>
      </header>
      <ul className="flex flex-col gap-1">
        {books.map((b) => (
          <li key={b.id}>
            <Link href={`/notenbuch/${b.id}`} prefetch={false} className="flex items-center gap-3 rounded-xl px-2 py-2 font-medium hover:bg-surface-2">
              <span className="min-w-0 flex-1 truncate">
                {b.subjectName} · {b.term}. Halbjahr
              </span>
              {b.locked && <Badge>abgeschlossen</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Members({ hub }: { hub: CourseHub }) {
  return (
    <Card aria-labelledby="mitglieder">
      <CardHeader title={<span id="mitglieder">Mitglieder ({hub.members.length})</span>} action={{ href: `/adressbuch/gruppe/${hub.group.id}`, label: "Adressbuch" }} />
      <ul className="flex flex-wrap gap-1.5">
        {hub.members.map((m) => (
          <li key={m.id}>
            <Badge tone={m.leader ? "soft" : "neutral"}>
              {m.name}
              {m.leader && " · Leitung"}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function KursraumPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const states = await loadModuleStates(db);
  if (!isEnabled(kurse, states)) notFound();
  const hub = await courseHub(db, perms, (await params).id, states);
  if (!hub) notFound();
  const { group } = hub;
  // „Mangel melden“ für den Raum, in dem der Kurs meistens ist (Gebäude & Technik, P4-13)
  const roomCounts = new Map<string, number>();
  for (const s of hub.lessons?.items ?? []) if (s.roomId) roomCounts.set(s.roomId, (roomCounts.get(s.roomId) ?? 0) + 1);
  const courseRoom = [...roomCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const today = toBerlinDate(new Date());
  const seatPlans =
    isEnabled(sitzplanModule, states) && (await canUseGroup(db, perms, group.id, today)) ? ((await plansByGroup(db, perms, [group.id], today)).get(group.id) ?? []) : null;
  const gradeBooks = isEnabled(notenbuchModule, states) ? await ownBookLinks(db, perms, { groupId: group.id, currentOnly: true }) : [];
  const reportHref = hasPermission(perms, "gebaeude.report") && isEnabled(gebaeude, states) ? `/gebaeude/melden${courseRoom ? `?raum=${encodeURIComponent(courseRoom)}` : ""}` : null;

  return (
    <main className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow={[group.kindLabel, group.subjectName, group.archived && "archiviert"].filter(Boolean).join(" · ")}
        title={group.name}
        actions={
          <>
            {reportHref && (
              <Link href={reportHref} className="text-sm font-medium text-accent-ink hover:underline">
                {courseRoom ? `Raum ${courseRoom} – Mangel melden` : "Mangel melden"}
              </Link>
            )}
            <Link href="/kurse" className="text-sm font-medium text-accent-ink hover:underline">
              Alle Kurse
            </Link>
          </>
        }
      />
      {group.color && <SubjectBar color={group.color} className="max-w-24" />}
      {group.description && <p className="max-w-3xl text-muted">{group.description}</p>}
      {!hub.member && <p className="text-sm text-muted">Du siehst diesen Kursraum über die Verwaltung, ohne Mitglied der Gruppe zu sein.</p>}
      {hub.conference && <ConferenceLink groupId={group.id} link={hub.conference.link} canEdit={hub.conference.canEdit} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {hub.quickPolls && (
          <Card aria-labelledby="schnellumfrage" className="lg:col-span-2">
            <CardHeader title={<span id="schnellumfrage">Schnellumfrage</span>} />
            <QuickPolls
              groupId={group.id}
              initial={hub.quickPolls.items}
              canStart={hub.quickPolls.canStart}
              empty={<p className="text-sm text-muted">Gerade läuft keine Schnellumfrage.</p>}
            />
          </Card>
        )}
        {hub.lessons && <Lessons hub={hub} />}
        {hub.homework && <Homework hub={hub} />}
        {hub.tasks && <Tasks hub={hub} />}
        {hub.events && <Events hub={hub} />}
        {hub.files && <Files hub={hub} />}
        {hub.chat && <Chat hub={hub} />}
        {hub.forum && <Forum hub={hub} />}
        {seatPlans && <SeatPlans groupId={group.id} plans={seatPlans} />}
        {gradeBooks.length > 0 && <GradeBooks books={gradeBooks} />}
        <Members hub={hub} />
        {hub.manage && hub.manage.length > 0 && (
          <Card aria-labelledby="bereiche">
            <CardHeader title={<span id="bereiche">Bereiche des Kurses</span>} />
            <p className="text-sm text-muted">Hier schaltest du, was der Kurs nutzt. Ausgeschaltete Bereiche verschwinden für alle Mitglieder; Inhalte bleiben erhalten.</p>
            <CourseAreas groupId={group.id} features={hub.manage} />
          </Card>
        )}
      </div>
    </main>
  );
}
