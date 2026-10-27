import { requireModulePage } from "@/core/modules/guard";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { isStaffRole } from "@/core/roles";
import { changeLabel, changeOff, changeRoomShift, changeTeacher, reasonLabel, subjectLabel } from "@/modules/stundenplan/display";
import { dayNotesOn, type DayNote } from "@/modules/stundenplan/tagesmitteilungen";
import { planDays, substitutionsOn, type DaySubstitution } from "@/modules/stundenplan/vertretung";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Vertretungsplan drucken" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });

function DayTable({ date, entries, notes }: { date: string; entries: DaySubstitution[]; notes: DayNote[] }) {
  const label = longDay.format(fromBerlinLocal(date));
  return (
    <section aria-label={label} className="flex break-inside-avoid flex-col gap-2">
      <h2 className="font-display text-lg font-bold">{label}</h2>
      {/* VT-02: Tagesmitteilungen oben */}
      {notes.length > 0 && (
        <ul aria-label="Tagesmitteilungen" className="flex list-disc flex-col gap-0.5 pl-5 text-sm font-semibold">
          {notes.map((n) => (
            <li key={n.id}>{n.body}</li>
          ))}
        </ul>
      )}
      {entries.length === 0 ? (
        <p className="text-sm">Keine Änderungen.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Vertretungsplan {label}</caption>
          <thead>
            <tr>
              {["Klasse", "Std.", "Fach", "Lehrkraft", "Art", "Vertretung", "Raum", "Grund", "Hinweis"].map((h) => (
                <th key={h} className="border border-border-strong px-2 py-1 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.id}-${e.periodNr}`} className={cn(i > 0 && entries[i - 1]!.groupId !== e.groupId && "border-t-2 border-ink")}>
                <td className="border border-border-strong px-2 py-1 font-semibold">{i === 0 || entries[i - 1]!.groupId !== e.groupId ? e.groupName : ""}</td>
                <td className="border border-border-strong px-2 py-1 tabular-nums">{e.periodNr}.</td>
                <td className={cn("border border-border-strong px-2 py-1", changeOff(e) && "line-through")}>{subjectLabel(e.subjectName, e.insteadOf)}</td>
                <td className="border border-border-strong px-2 py-1">{e.teacherCode ?? "–"}</td>
                <td className="border border-border-strong px-2 py-1 font-semibold">{changeLabel(e)}</td>
                <td className="border border-border-strong px-2 py-1">{changeTeacher(e) ?? ""}</td>
                <td className="border border-border-strong px-2 py-1 whitespace-nowrap">{changeRoomShift(e) ?? ""}</td>
                <td className="border border-border-strong px-2 py-1">{reasonLabel(e.reason) ?? ""}</td>
                <td className="border border-border-strong px-2 py-1">{e.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Druckansicht des Vertretungsplans: heute bzw. nächster Schultag und der Tag danach, nach Klassen sortiert. */
export default async function VertretungsplanDruckPage() {
  await requireModulePage("stundenplan");
  const { user } = await requireUser();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const days = planDays(today, await loadSchoolCalendar(db));
  const [entries, notes] = await Promise.all([substitutionsOn(db, days), dayNotesOn(db, days, { staff: isStaffRole(user.role) })]);
  const sorted = [...entries].sort(
    (a, b) => (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.groupName.localeCompare(b.groupName, "de", { numeric: true }) || a.periodNr - b.periodNr,
  );
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/stundenplan/vertretungen">Zurück zum Vertretungsplan</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-5">
        <DruckKopf
          title="Vertretungsplan"
          stamp={`Stand ${shortDate.format(new Date())}, ${new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: TZ }).format(new Date())} Uhr`}
        />
        {days.map((d) => (
          <DayTable key={d} date={d} entries={sorted.filter((e) => e.date === d)} notes={notes.filter((n) => n.date === d)} />
        ))}
      </main>
    </div>
  );
}
