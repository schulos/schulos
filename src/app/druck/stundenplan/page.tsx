import { requireModulePage } from "@/core/modules/guard";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { isStaffRole } from "@/core/roles";
import { groups, users } from "@/core/db/schema";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, isoWeek, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { mergeCoupled, slotDisplay, type PlanView } from "@/modules/stundenplan/display";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { myDutiesBetween, myDutyWeek } from "@/modules/stundenplan/aufsichten";
import { canViewPlan, listSlots, seesAllPlans, regularSlots, timetableMasterData, weekOf, type LessonSlot, type PlanTarget } from "@/modules/stundenplan/service";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Stundenplan drucken" };

type Params = { gruppe?: string; lehrkraft?: string; raum?: string; person?: string; woche?: string; art?: string };

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const fmt = (ymd: string) => shortDate.format(fromBerlinLocal(ymd));
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function targetFrom(sp: Params): PlanTarget | null {
  if (sp.gruppe) return { kind: "group", id: sp.gruppe };
  if (sp.lehrkraft) return { kind: "teacher", id: sp.lehrkraft };
  if (sp.raum) return { kind: "room", id: sp.raum };
  if (sp.person) return { kind: "user", id: sp.person };
  return null;
}

/** Druckansicht eines Plans (Klasse, Lehrkraft, Raum, Person): Regelplan oder eine Woche mit Vertretungen. */
export default async function StundenplanDruckPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireModulePage("stundenplan");
  const { user, perms } = await requireUser();
  const sp = await searchParams;
  const target = targetFrom(sp) ?? { kind: "user" as const, id: user.id };
  const db = await getDb();
  if (!(await canViewPlan(db, perms, target)) && !(target.kind === "user" && target.id === user.id)) notFound();

  const today = toBerlinDate(new Date());
  const thisWeek = weekdayMon0(today) >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const monday = YMD.test(sp.woche ?? "") ? mondayOf(sp.woche!) : thisWeek;
  const regular = sp.art !== "woche";
  // Regelplan: Stand = heute, bei einer späteren Woche deren Montag
  const ref = monday > today ? monday : today;

  const [master, cal] = await Promise.all([timetableMasterData(db), loadSchoolCalendar(db)]);
  let title = "Stundenplan";
  let view: PlanView = "student";
  if (target.kind === "group") {
    const [g] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, target.id));
    if (!g) notFound();
    title = g.name;
    view = "group";
  } else if (target.kind === "teacher" || target.kind === "user") {
    const [u] = await db.select({ name: users.name, code: users.shortCode, role: users.role }).from(users).where(eq(users.id, target.id));
    if (!u) notFound();
    title = u.code ? `${u.name} (${u.code})` : u.name;
    view = target.kind === "teacher" || isStaffRole(u.role) ? "teacher" : "student";
  } else {
    title = `Raum ${target.id}`;
    view = "room";
  }

  const raw = regular ? await regularSlots(db, target, ref) : await listSlots(db, target, monday, addDays(monday, 5));
  const slots = view === "teacher" || view === "room" ? mergeCoupled(raw) : raw;
  const days = WEEKDAYS.map((_, i) => addDays(monday, i));
  const lastPeriod = Math.max(6, ...slots.map((x) => x.periodNr));
  const subtitle = regular ? `Regelplan · Stand ${fmt(ref)}` : `KW ${isoWeek(monday)} (${weekOf(monday)}-Woche) · ${fmt(monday)} – ${fmt(days[4]!)} · mit Vertretungen`;

  // Q5-09: Pausenaufsichten der Lehrkraft (eigener Plan oder Kollegium; Schüler:innen/Eltern sehen sie nicht)
  const dutyTeacher = view === "teacher" && (target.kind === "teacher" || target.kind === "user") && (target.id === user.id || seesAllPlans(perms)) ? target.id : null;
  const duties = !dutyTeacher
    ? []
    : regular
      ? (await myDutyWeek(db, dutyTeacher)).map((d) => ({ ...d, key: `${d.weekday}-${d.afterPeriod}`, covering: false }))
      : (await myDutiesBetween(db, dutyTeacher, monday, addDays(monday, 5))).map((d) => ({ ...d, weekday: weekdayMon0(d.date), key: `${d.date}-${d.afterPeriod}-${d.dutyId}`, covering: d.kind === "covering" }));

  const keep = Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "art" && k !== "woche")) as Record<string, string>;
  const link = (p: Record<string, string>) => `/druck/stundenplan?${new URLSearchParams({ ...keep, ...p })}`;
  const back = `/stundenplan?${new URLSearchParams({ ...keep, woche: monday })}`;

  const cell = (s: LessonSlot) => {
    const d = slotDisplay(s, view);
    return (
      <div key={`${s.lessonId}-${s.date}`} className={cn("flex gap-1.5 border-l-4 pl-1.5", d.tone === "sub" && "font-semibold")} style={{ borderColor: s.color }}>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className={cn("font-semibold", d.struck && "line-through")}>
            {s.subjectName}
            {regular && s.week !== "all" && <span className="font-normal"> ({s.week}-Woche)</span>}
          </span>
          <span className="text-xs">{d.detail}</span>
          {!regular && d.tag && (
            <span className="text-xs font-semibold">
              {d.tag}
              {d.note ? ` · ${d.note}` : ""}
            </span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={back}>Zurück zum Plan</Link>
        </Button>
        <Button asChild size="sm" variant={regular ? "secondary" : "ghost"}>
          <Link href={link({ woche: monday })} aria-current={regular ? "page" : undefined}>
            Regelplan
          </Link>
        </Button>
        <Button asChild size="sm" variant={regular ? "ghost" : "secondary"}>
          <Link href={link({ art: "woche", woche: monday })} aria-current={regular ? undefined : "page"}>
            Woche mit Vertretungen
          </Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-3">
        <DruckKopf title={title} subtitle={subtitle} stamp={`gedruckt am ${fmt(today)}`} />
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {title} – {subtitle}
          </caption>
          <thead>
            <tr>
              <th className="w-20 border border-border-strong px-2 py-1 text-left">Stunde</th>
              {days.map((d, i) => (
                <th key={d} className="border border-border-strong px-2 py-1 text-left">
                  {WEEKDAYS[i]}
                  {!regular && <span className="font-normal"> {fmt(d).slice(0, 6)}</span>}
                  {!regular && cal.dayOff(d) && <span className="block text-xs font-normal">{dayOffLabel(cal.dayOff(d)!)}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {master.periods
              .filter((p) => p.nr <= lastPeriod)
              .map((p) => (
                <tr key={p.nr} className="break-inside-avoid">
                  <td className="border border-border-strong px-2 py-1 align-top">
                    <span className="font-semibold">{p.nr}.</span>
                    <span className="block text-xs tabular-nums">
                      {p.startsAt}–{p.endsAt}
                    </span>
                  </td>
                  {days.map((d, i) => (
                    <td key={d} className="h-12 border border-border-strong px-1.5 py-1 align-top">
                      <div className="flex flex-col gap-1">{slots.filter((s) => (regular ? s.weekday === i : s.date === d) && s.periodNr === p.nr).map(cell)}</div>
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {slots.length === 0 && <p className="text-sm">Keine Stunden.</p>}
        {duties.length > 0 && (
          <section aria-label="Aufsichten" className="break-inside-avoid text-sm">
            <h2 className="font-semibold">Pausenaufsichten</h2>
            <ul className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3">
              {duties.map((d) => (
                <li key={d.key}>
                  <span className="font-semibold">{WEEKDAYS[d.weekday]}</span> nach der {d.afterPeriod}. ({d.startsAt}) · {d.areaName}
                  {d.covering && <span className="font-semibold"> · Vertretung</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
