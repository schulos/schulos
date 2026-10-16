import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { SubjectBar } from "@schulos/ui/misc";
import Link from "next/link";
import { homeworkOwners, upcomingHomeworkFor, type HomeworkItem } from "./homework";
import { GAP_SCHOOL_DAYS, gapTitle, openLessons } from "./luecken";

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "numeric", timeZone: TZ });
const shortFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });

function dueLabel(ymd: string, today: string): string {
  if (ymd === today) return "Heute";
  if (ymd === addDays(today, 1)) return "Morgen";
  return dayFmt.format(fromBerlinLocal(ymd));
}

function HomeworkList({ items, today }: { items: HomeworkItem[]; today: string }) {
  const days = [...new Set(items.map((i) => i.due!))];
  return (
    <div className="flex flex-col gap-3">
      {days.map((d) => (
        <section key={d} aria-label={`Fällig ${dueLabel(d, today)}`} className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{dueLabel(d, today)}</h3>
          <ul className="flex flex-col gap-2">
            {items
              .filter((i) => i.due === d)
              .map((i) => (
                <li key={i.entryId} className="flex items-stretch gap-3">
                  <SubjectBar color={i.color} className="h-auto w-1 shrink-0" />
                  <span className="flex min-w-0 flex-col leading-snug">
                    <span className="font-medium">{i.subjectName}</span>
                    <span className="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{i.homework}</span>
                    <span className="text-xs text-muted">aufgegeben {shortFmt.format(fromBerlinLocal(i.givenOn))}</span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Q5-02: Hausaufgaben der nächsten Schultage (Schüler:innen immer, Eltern nach Moduleinstellung). */
async function Hausaufgaben({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const owners = await homeworkOwners(db, current.perms);
  if (owners.length === 0) return null;
  const today = toBerlinDate(new Date());
  const lists = await Promise.all(owners.map(async (o) => ({ owner: o, items: await upcomingHomeworkFor(db, o.id, today) })));
  const many = owners.length > 1;
  return (
    <Card aria-label="Hausaufgaben">
      <CardHeader title="Hausaufgaben" />
      <div className="flex flex-col gap-4">
        {lists.map(({ owner, items }) => (
          <div key={owner.id} className="flex flex-col gap-2">
            {many && <h3 className="text-sm font-semibold">{owner.name}</h3>}
            {items.length === 0 ? (
              <p className="text-sm text-muted">Für die nächsten Schultage ist nichts eingetragen.</p>
            ) : (
              <HomeworkList items={items} today={today} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** höchstens so viele offene Stunden im Widget, der Rest über „Alle“ */
const GAP_WIDGET_MAX = 4;

/** Q5-06: eigene Stunden ohne Eintrag (nur die Lehrkraft selbst); ohne Lücken kein Widget. */
async function OhneEintrag({ current }: { current: CurrentUser }) {
  const gaps = await openLessons(await getDb(), current.user.id);
  if (gaps.length === 0) return null;
  return (
    <Card aria-label="Klassenbuch ohne Eintrag">
      <CardHeader title={gapTitle(gaps.length)} action={{ href: "/klassenbuch#offen", label: "Alle" }} />
      <p className="text-sm text-muted">Letzte {GAP_SCHOOL_DAYS} Schultage · nur für dich sichtbar</p>
      <ul className="flex flex-col gap-1.5">
        {gaps.slice(0, GAP_WIDGET_MAX).map((g) => (
          <li key={`${g.lessonId}:${g.date}`}>
            <Link href={`/klassenbuch/eintrag?stunde=${g.lessonId}&datum=${g.date}`} className="flex items-center gap-3 rounded-lg py-1 hover:underline">
              <SubjectBar color={g.color} className="h-5 w-1 shrink-0" />
              <span className="text-sm">
                {shortFmt.format(fromBerlinLocal(g.date))} · {g.periodNr}. Std · {g.subjectName} · {g.groupName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const klassenbuchWidgets: WidgetDef[] = [
  { id: "klassenbuch.hausaufgaben", moduleId: "klassenbuch", order: 7, roles: ["schueler", "eltern"], Component: Hausaufgaben },
  { id: "klassenbuch.ohne-eintrag", moduleId: "klassenbuch", order: 7, roles: ["lehrkraft"], Component: OhneEintrag },
];
