import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/core/db/client";
import { classbookEntries } from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { hasPermission } from "@/core/permissions";
import { getModule } from "@/modules";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, toBerlinDate, toBerlinLocal } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { AutoRefresh } from "@schulos/ui/auto-refresh";
import { cn } from "@schulos/ui/cn";
import { examIndex, examLabel, listExams, type ExamRow } from "@/modules/klausurplan/service";
import { plansByGroup } from "@/modules/sitzplan/service";
import { mergeCoupled, slotDisplay } from "./display";
import { myDutiesBetween } from "./aufsichten";
import { listSlots, planOwners, weekOf } from "./service";
import { dayStrip, firstDayWithLessons, type StripItem } from "./today";
import { materialsFor } from "./selbstmeldung";
import { dayNotesOn } from "./tagesmitteilungen";
import { acknowledgeEnabled, ownSubstitutions } from "./vertretung";
import { isStaffRole } from "@/core/roles";

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const untilFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });

function dayLabel(ymd: string, today: string): string {
  if (ymd === today) return "Heute";
  if (ymd === addDays(today, 1)) return "Morgen";
  return dayFmt.format(fromBerlinLocal(ymd));
}

function StripCard({ item, staff, exam, href, open }: { item: StripItem; staff: boolean; exam?: ExamRow; href?: string; open?: boolean }) {
  const d = slotDisplay(item, staff ? "teacher" : "student", true);
  const card = (
    <article
      data-period={item.periodNr}
      data-state={item.state}
      data-tone={d.tone}
      className={cn(
        "flex min-h-28 flex-col gap-1.5 rounded-2xl border border-border bg-surface px-3.5 pt-3 pb-3.5",
        d.tone === "sub" && "border-warn-border bg-warn-soft",
        // A11Y-01c: vorbei = gedämpfte Fläche statt Deckkraft – opacity-55 drückte die Schrift unter 4,5 : 1 (axe „color-contrast“)
        item.state === "done" && "border-dashed bg-surface-2",
        item.state === "now" && "border-2 border-accent shadow-[0_6px_20px_rgb(20_24_31/0.08)]",
      )}
    >
      <div aria-hidden className={cn("h-1 rounded-full", (d.tone === "off" || item.state === "done") && "opacity-40")} style={{ background: item.color }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-muted tabular-nums">
          {item.periodNr}. Std · {item.startsAt}
        </span>
        {item.state === "now" && !d.tag && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg">Jetzt</span>}
        {d.tag && (
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", d.tone === "sub" ? "bg-warn text-surface" : "bg-surface-2 text-muted ring-1 ring-border")}>{d.tag}</span>
        )}
      </div>
      <strong className={cn("text-[17px] leading-tight font-semibold [overflow-wrap:anywhere]", (d.struck || item.state === "done") && "text-muted", d.struck && "line-through")}>{item.subjectName}</strong>
      <span className="text-sm text-muted">
        {d.detail}
        {item.state === "now" && !d.struck && ` · noch ${item.minutesLeft} Min.`}
      </span>
      {d.reason && <span className="text-xs text-muted">{d.reason}</span>}
      {d.note && <span className="text-sm">{d.note}</span>}
      {exam && <span className="text-sm font-semibold text-danger">{examLabel(exam, item.subjectId)}</span>}
      {open && <span className="text-xs font-semibold text-warn">Klassenbuch offen</span>}
    </article>
  );
  // Q5-06: Karte führt weiter – Lehrkraft zum Klassenbuch-Eintrag, Schüler:in in den Kursraum der Gruppe
  return href ? (
    <Link href={href} className="rounded-2xl transition hover:brightness-[0.98]">
      {card}
      {/* WCAG 2.5.3: der zugängliche Name besteht aus dem sichtbaren Kartentext, das Ziel kommt nur dazu */}
      <span className="sr-only">{staff ? "– zum Klassenbuch-Eintrag" : "– zum Kursraum"}</span>
    </Link>
  ) : (
    card
  );
}

/** „, davon 1 Vertretung · 1 entfällt“ – wie im Mockup */
function changes(items: StripItem[]): string {
  const sub = items.filter((i) => i.change && i.change.kind !== "cancel" && i.perspective !== "away").length;
  const off = items.filter((i) => i.change?.kind === "cancel" || i.perspective === "away").length;
  const parts = [sub && `${sub} ${sub === 1 ? "Änderung" : "Änderungen"}`, off && `${off} entfällt`].filter(Boolean);
  return parts.length ? `, davon ${parts.join(" · ")}` : "";
}

async function Tagesleiste({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const owners = await planOwners(db, current.perms);
  if (owners.length === 0) return null;
  const now = new Date();
  const today = toBerlinDate(now);
  const hm = toBerlinLocal(now).slice(11);
  const staff = current.user.role === "lehrkraft";
  const states = await loadModuleStates(db);
  const on = (id: string) => {
    const m = getModule(id);
    return !!m && isEnabled(m, states);
  };
  const classbook = staff && on("klassenbuch");
  const courses = current.user.role === "schueler" && on("kurse") && hasPermission(current.perms, "kurse.view");
  // Feiertag/Ferien heute: Grund und Ende statt „kein Unterricht“
  const off = (await loadSchoolCalendar(db)).dayOff(today);
  const offText = off && `${dayOffLabel(off)}${off.until > today ? ` · bis ${untilFmt.format(fromBerlinLocal(off.until))}` : ""}`;
  const ack = staff && (await acknowledgeEnabled(db));

  const strips = await Promise.all(
    owners.map(async (o) => {
      const raw = await listSlots(db, { kind: "user", id: o.id }, today, addDays(today, 8));
      const slots = staff && o.id === current.user.id ? mergeCoupled(raw) : raw;
      const todays = dayStrip(slots, today, today, hm);
      // Ist der Unterricht heute vorbei (oder gibt es keinen), zeigt die Leiste den nächsten Schultag
      const day = todays.some((s) => s.state !== "done") ? today : firstDayWithLessons(slots, addDays(today, 1));
      const items = day ? dayStrip(slots, day, today, hm) : [];
      const exams = examIndex(day && items.length ? await listExams(db, current.perms, day, addDays(day, 1), [...new Set(items.map((i) => i.groupId))]) : []);
      // eigene Stunden heute: welche haben schon einen Klassenbuch-Eintrag?
      const writable = classbook && o.id === current.user.id && day === today ? items.filter((i) => i.change?.kind !== "cancel" && i.perspective !== "away") : [];
      const entered = writable.length
        ? new Set(
            (
              await db
                .select({ lessonId: classbookEntries.lessonId })
                .from(classbookEntries)
                .where(and(eq(classbookEntries.date, today), inArray(classbookEntries.lessonId, writable.map((i) => i.lessonId))))
            ).map((r) => r.lessonId),
          )
        : new Set<string | null>();
      const links = new Map<StripItem, { href: string; open: boolean }>();
      for (const i of writable) links.set(i, { href: `/klassenbuch/eintrag?stunde=${i.lessonId}&datum=${i.date}`, open: i.state === "done" && !entered.has(i.lessonId) });
      if (courses && o.id === current.user.id) for (const i of items) links.set(i, { href: `/kurse/${i.groupId}`, open: false });
      // Q5-09: eigene Pausenaufsichten des gezeigten Tages als Chips
      const duties = staff && o.id === current.user.id && day ? await myDutiesBetween(db, o.id, day, addDays(day, 1)) : [];
      // P5-03: Sitzpläne der eigenen Gruppen des gezeigten Tages (nur Lehrkräfte der Gruppe)
      const seatPlans =
        staff && o.id === current.user.id && on("sitzplan") && items.length
          ? [...(await plansByGroup(db, current.perms, [...new Set(items.filter((i) => i.change?.kind !== "cancel" && i.perspective !== "away").map((i) => i.groupId))], today))]
              .flatMap(([groupId, plans]) => plans.map((p) => ({ ...p, groupName: items.find((i) => i.groupId === groupId)?.groupName ?? "" })))
          : [];
      // Q5-12: Vertretungsmaterial – Lehrkräfte für Stunden, die sie vertreten; Schüler:innen, wenn die Lehrkraft es freigegeben hat
      const materialItems = o.id === current.user.id ? items.filter((i) => (staff ? i.perspective === "covering" : current.user.role === "schueler")) : [];
      const mats = await materialsFor(db, current.perms, materialItems.map((i) => ({ lessonId: i.lessonId, date: i.date })));
      const materials = materialItems.flatMap((i) => {
        const m = mats.get(`${i.lessonId}:${i.date}`);
        return m ? [{ id: m.id, label: `${i.periodNr}. Std ${i.groupName}` }] : [];
      });
      // VT-02: Tagesmitteilungen des gezeigten Tages; Lehrkräfte: eigene Vertretungen, die noch nicht bestätigt sind (F-10-10)
      const notes = day ? await dayNotesOn(db, [day], { staff: isStaffRole(current.user.role) }) : [];
      const unconfirmed =
        staff && o.id === current.user.id && day && ack ? (await ownSubstitutions(db, o.id, [day])).filter((e) => !e.internal?.acknowledgedAt) : [];
      return { owner: o, day, items, exams, links, duties, seatPlans, materials, notes, unconfirmed };
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh />
      {strips.map(({ owner, day, items, exams, links, duties, seatPlans, materials, notes, unconfirmed }) => (
        <section key={owner.id} aria-label={owners.length > 1 ? `Tagesleiste ${owner.name}` : "Tagesleiste"} data-day={day ?? undefined} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-base font-semibold">
              {owners.length > 1 && <span>{owner.name} · </span>}
              {day ? dayLabel(day, today) : (offText ?? "Diese Woche kein Unterricht")}
              {day && (
                <span className="font-normal text-muted">
                  {" "}
                  · {items.length} {items.length === 1 ? "Stunde" : "Stunden"}
                  {changes(items)}
                  {" "}· {weekOf(day)}-Woche
                </span>
              )}
            </h2>
            <Link href={owners.length > 1 ? `/stundenplan?person=${owner.id}` : "/stundenplan"} className="text-sm font-medium text-accent-ink hover:underline">
              Wochenplan
            </Link>
          </div>
          {notes.length > 0 && (
            <ul aria-label="Tagesmitteilungen" className="flex flex-col gap-1.5">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent-ink">
                  {n.body}
                </li>
              ))}
            </ul>
          )}
          {unconfirmed.length > 0 && (
            <ul aria-label="Vertretungen bestätigen" className="flex flex-wrap gap-2">
              {unconfirmed.map((e) => (
                <li key={e.id}>
                  <Link
                    href="/stundenplan/vertretungen#meine-vertretungen"
                    className="rounded-full border border-warn-border bg-warn-soft px-3 py-1 text-sm font-medium text-warn hover:border-border-strong"
                  >
                    Vertretung {e.periodNr}. Std {e.groupName} – bitte bestätigen
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {duties.length > 0 && (
            <ul aria-label="Meine Aufsichten" className="flex flex-wrap gap-2">
              {duties.map((d) => (
                <li
                  key={d.dutyId}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm font-medium",
                    d.kind === "covering" ? "border-warn-border bg-warn-soft text-warn" : "border-border bg-surface-2",
                  )}
                >
                  Aufsicht {d.areaName} nach der {d.afterPeriod}. · {d.startsAt}
                  {d.kind === "covering" && " · Vertretung"}
                </li>
              ))}
            </ul>
          )}
          {seatPlans.length > 0 && (
            <ul aria-label="Sitzpläne" className="flex flex-wrap gap-2">
              {seatPlans.map((p) => (
                <li key={p.id}>
                  <Link href={`/sitzplan/${p.id}`} className="rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-medium hover:border-border-strong">
                    Sitzplan {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {materials.length > 0 && (
            <ul aria-label="Vertretungsmaterial" className="flex flex-wrap gap-2">
              {materials.map((m) => (
                <li key={m.id}>
                  <Link href={`/stundenplan/material/${m.id}`} className="rounded-full border border-warn-border bg-warn-soft px-3 py-1 text-sm font-medium text-warn hover:border-border-strong">
                    Material {m.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {items.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
              {items.map((item) => (
                <StripCard
                  key={`${item.lessonId}-${item.date}`}
                  item={item}
                  staff={staff}
                  exam={exams.get(`${item.groupId}:${item.date}:${item.periodNr}`)}
                  href={links.get(item)?.href}
                  open={links.get(item)?.open}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export const stundenplanWidgets: WidgetDef[] = [
  { id: "stundenplan.tagesleiste", moduleId: "stundenplan", order: 0, size: "full", roles: ["schueler", "lehrkraft", "eltern"], Component: Tagesleiste },
];
