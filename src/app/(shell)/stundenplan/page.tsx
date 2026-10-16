import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, isoWeek, mondayOf, toBerlinDate, toBerlinLocal, weekdayMon0 } from "@/core/time";
import { plannableGroups, teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { examIndex, examLabel, listExams, type ExamRow } from "@/modules/klausurplan/service";
import { mergeCoupled, slotDisplay, type PlanView } from "@/modules/stundenplan/display";
import { canViewPlan, listSlots, planOwners, timetableMasterData, weekOf, type LessonSlot, type PlanTarget } from "@/modules/stundenplan/service";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { PlanPicker } from "./plan-picker";

export const metadata: Metadata = { title: "Stundenplan" };

const STAFF = ["lehrkraft", "verwaltung", "admin"];
const shortDate = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: TZ });
const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const fmt = (f: Intl.DateTimeFormat, ymd: string) => f.format(fromBerlinLocal(ymd));

type Params = { woche?: string; person?: string; gruppe?: string; lehrkraft?: string; raum?: string };

function targetFrom(sp: Params): PlanTarget | null {
  if (sp.gruppe) return { kind: "group", id: sp.gruppe };
  if (sp.lehrkraft) return { kind: "teacher", id: sp.lehrkraft };
  if (sp.raum) return { kind: "room", id: sp.raum };
  if (sp.person) return { kind: "user", id: sp.person };
  return null;
}

function LessonChip({ s, view, now, exam }: { s: LessonSlot; view: PlanView; now: boolean; exam?: ExamRow }) {
  const d = slotDisplay(s, view);
  return (
    <div
      data-tone={d.tone}
      className={cn(
        "flex gap-2 rounded-lg border border-border bg-surface px-2 py-1.5",
        d.tone === "sub" && "border-warn-border bg-warn-soft",
        now && "border-2 border-accent",
      )}
    >
      <span aria-hidden className={cn("w-1 shrink-0 self-stretch rounded-full", d.tone === "off" && "opacity-40")} style={{ background: s.color }} />
      <span className="flex min-w-0 flex-col">
        <span className={cn("font-medium [overflow-wrap:anywhere]", d.struck && "text-muted line-through")}>{s.subjectName}</span>
        <span className="text-xs text-muted">{d.detail}</span>
        {d.tag && <span className={cn("text-xs font-semibold", d.tone === "sub" ? "text-warn" : "text-muted")}>{d.tag}{d.note ? ` · ${d.note}` : ""}</span>}
        {exam && <span className="text-xs font-semibold text-danger">{examLabel(exam, s.subjectId)}</span>}
      </span>
    </div>
  );
}

export default async function StundenplanPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { user, perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  const owners = await planOwners(db, perms);
  const isStaff = STAFF.includes(user.role);

  const target: PlanTarget | null = targetFrom(sp) ?? (owners[0] ? { kind: "user", id: owners[0].id } : null);
  if (target && !(await canViewPlan(db, perms, target))) notFound();

  const now = new Date();
  const today = toBerlinDate(now);
  const hm = toBerlinLocal(now).slice(11);
  // am Wochenende gleich die kommende Woche zeigen (wie die Tagesleiste)
  const thisWeek = weekdayMon0(today) >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(sp.woche ?? "") ? mondayOf(sp.woche!) : thisWeek;
  const days = WEEKDAYS.map((_, i) => addDays(monday, i));

  const [master, groupsList, teachers, cal] = await Promise.all([
    timetableMasterData(db),
    isStaff ? plannableGroups(db) : Promise.resolve([]),
    isStaff ? teacherOptions(db) : Promise.resolve([]),
    loadSchoolCalendar(db),
  ]);
  // Feiertage, Ferien, unterrichtsfreie Tage der Woche
  const offs = new Map(days.flatMap((d) => {
    const off = cal.dayOff(d);
    return off ? [[d, off] as const] : [];
  }));
  const view: PlanView =
    target?.kind === "group" ? "group" : target?.kind === "room" ? "room" : target?.kind === "teacher" ? "teacher" : target && target.id === user.id && isStaff ? "teacher" : "student";
  const raw = target ? await listSlots(db, target, monday, addDays(monday, 5)) : [];
  // Lehrkraft- und Raumsicht: gekoppelte Gruppen als eine Stunde
  const slots = view === "teacher" || view === "room" ? mergeCoupled(raw) : raw;
  const exams = examIndex(slots.length ? await listExams(db, perms, monday, addDays(monday, 5), [...new Set(slots.map((x) => x.groupId))]) : []);
  const examOf = (x: LessonSlot) => exams.get(`${x.groupId}:${x.date}:${x.periodNr}`);

  let title = "Stundenplan";
  if (target?.kind === "group") title = groupsList.find((g) => g.id === target.id)?.name ?? title;
  if (target?.kind === "teacher") title = teachers.find((t) => t.id === target.id)?.name ?? title;
  if (target?.kind === "room") title = `Raum ${target.id}`;
  if (target?.kind === "user" && target.id !== user.id) title = owners.find((o) => o.id === target.id)?.name ?? title;
  if (target?.kind === "user" && target.id === user.id) title = "Mein Stundenplan";

  const keep = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== "woche" && v) as [string, string][]);
  const weekHref = (ymd: string) => {
    const q = new URLSearchParams(keep);
    q.set("woche", ymd);
    return `/stundenplan?${q}`;
  };
  const isNow = (s: LessonSlot) => s.date === today && s.startsAt <= hm && hm < s.endsAt;
  // leere Stunden am Ende (z. B. 8. Stunde ohne Unterricht) ausblenden, mindestens bis zur 6.
  const lastPeriod = Math.max(6, ...slots.map((x) => x.periodNr));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Stundenplan"
        title={title}
        actions={
          <>
            {target && (
              <Button asChild>
                <Link href={`/druck/stundenplan?${new URLSearchParams({ ...Object.fromEntries(keep), woche: monday })}`}>
                  <Printer aria-hidden /> Drucken
                </Link>
              </Button>
            )}
            <Button asChild>
              <Link href="/stundenplan/vertretungen">Vertretungsplan</Link>
            </Button>
          </>
        }
      />

      {owners.length > 1 && (
        <nav aria-label="Kind wählen" className="flex flex-wrap gap-2">
          {owners.map((o) => (
            <Button key={o.id} asChild size="sm" variant={target?.kind === "user" && target.id === o.id ? "primary" : "secondary"}>
              <Link href={`/stundenplan?person=${o.id}`}>{o.name}</Link>
            </Button>
          ))}
        </nav>
      )}

      {isStaff && (
        <PlanPicker>
          <Select name="gruppe" defaultValue={target?.kind === "group" ? target.id : ""} aria-label="Klasse oder Kurs">
            <option value="">Klasse oder Kurs …</option>
            {(["klasse", "kurs", "ag"] as const).map((kind) => (
              <optgroup key={kind} label={GROUP_KIND_LABELS[kind]}>
                {groupsList
                  .filter((g) => g.kind === kind)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Select name="lehrkraft" defaultValue={target?.kind === "teacher" ? target.id : ""} aria-label="Lehrkraft">
            <option value="">Lehrkraft …</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} – {t.name}
              </option>
            ))}
          </Select>
          <Select name="raum" defaultValue={target?.kind === "room" ? target.id : ""} aria-label="Raum">
            <option value="">Raum …</option>
            {master.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === r.name ? r.id : `${r.id} – ${r.name}`}
              </option>
            ))}
          </Select>
          <Button type="submit">Anzeigen</Button>
        </PlanPicker>
      )}

      {!target ? (
        <EmptyState title="Welchen Plan möchtest du sehen?">Wähle oben eine Klasse, eine Lehrkraft oder einen Raum.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
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
              <h2 className="ml-1 font-semibold">
                KW {isoWeek(monday)} · {weekOf(monday)}-Woche
                <span className="block font-normal text-muted sm:inline">
                  <span className="hidden sm:inline"> · </span>
                  {fmt(shortDate, monday)} – {fmt(shortDate, days[4]!)}
                </span>
              </h2>
            </div>
            {monday !== thisWeek && (
              <Button asChild size="sm">
                <Link href={weekHref(thisWeek)}>Diese Woche</Link>
              </Button>
            )}
          </div>

          {slots.length === 0 ? (
            offs.size === days.length ? (
              <EmptyState title={[...new Set([...offs.values()].map(dayOffLabel))].join(" · ")}>In dieser Woche ist kein Unterricht.</EmptyState>
            ) : (
              <EmptyState title="Keine Stunden in dieser Woche" />
            )
          ) : (
            <>
              {/* Desktop: Wochenraster */}
              <div className="hidden overflow-x-auto rounded-card border border-border bg-surface md:block">
                <table className="w-full table-fixed border-collapse text-sm">
                  <caption className="sr-only">
                    {title}, KW {isoWeek(monday)}
                  </caption>
                  <thead>
                    <tr>
                      <th className="w-24 px-3 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">Stunde</th>
                      {days.map((d, i) => (
                        <th key={d} className={cn("px-2 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase", d === today && "text-accent-ink")}>
                          {WEEKDAYS[i]} <span className="font-normal normal-case">{fmt(shortDate, d)}</span>
                          {offs.get(d) && <span className="block truncate font-normal normal-case tracking-normal">{dayOffLabel(offs.get(d)!)}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {master.periods.filter((p) => p.nr <= lastPeriod).map((p) => (
                      <tr key={p.nr} className="border-t border-border">
                        <td className="px-3 py-2 align-top whitespace-nowrap">
                          <span className="font-semibold">{p.nr}.</span>
                          <span className="block text-xs text-muted tabular-nums">
                            {p.startsAt}–{p.endsAt}
                          </span>
                        </td>
                        {days.map((d) => (
                          <td key={d} className={cn("px-1.5 py-1.5 align-top", d === today && "bg-accent-soft/40", offs.has(d) && "bg-surface-2/60")}>
                            <div className="flex flex-col gap-1">
                              {slots
                                .filter((s) => s.date === d && s.periodNr === p.nr)
                                .map((s) => (
                                  <LessonChip key={s.lessonId} s={s} view={view} now={isNow(s)} exam={examOf(s)} />
                                ))}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobil: Tagesliste */}
              <div className="flex flex-col gap-5 md:hidden">
                {days.map((d) => {
                  const mine = slots.filter((s) => s.date === d);
                  return (
                    <section key={d} aria-label={fmt(longDay, d)} className="flex flex-col gap-2">
                      <h3 className={cn("text-sm font-semibold", d === today ? "text-accent-ink" : "text-muted")}>
                        {d === today ? "Heute · " : ""}
                        {fmt(longDay, d)}
                      </h3>
                      {mine.length === 0 ? (
                        <p className="text-sm text-muted">{offs.get(d) ? dayOffLabel(offs.get(d)!) : "kein Unterricht"}</p>
                      ) : (
                        <ul className="flex flex-col gap-1.5">
                          {mine.map((s) => (
                            <li key={s.lessonId} className="grid grid-cols-[3.25rem_1fr] items-center gap-2">
                              <span className="text-xs text-muted tabular-nums">
                                <span className="font-semibold text-ink">{s.periodNr}.</span> {s.startsAt}
                              </span>
                              <LessonChip s={s} view={view} now={isNow(s)} exam={examOf(s)} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
