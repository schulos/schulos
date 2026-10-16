import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { count, isNotNull } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TIME_GRIDS, defaultTimeGrid } from "@/core/school/templates";
import { STATES, formName, gradeTemplate } from "@/core/school/catalog";
import { TZ, fromBerlinLocal, weekdayMon0 } from "@/core/time";
import { readSchoolSettings } from "@/core/settings";
import { listSchoolYears, schoolYearUsage } from "@/modules/verwaltung/school-years";
import {
  applyCurriculumTemplateAction,
  applyGradeTemplateAction,
  applyTimeGridAction,
  saveCurriculumAction,
  saveClosuresAction,
  setHolidayAutoAction,
  syncHolidaysAction,
  saveGradeLevelsAction,
  savePeriodsAction,
  saveSchoolYearsAction,
  saveSubjectsAction,
} from "@/modules/verwaltung/stammdaten-actions";
import { breaks, listCurriculum, listGradeLevels, listPeriods, listSubjects, subjectUsage } from "@/modules/verwaltung/stammdaten";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { PageHeader } from "@schulos/ui/misc";
import { ClosuresForm } from "./closures-form";
import { HOLIDAY_LICENSE, HOLIDAY_SOURCE_LABEL, HOLIDAY_SOURCE_URL, holidayAutoEnabled, lastHolidaySync } from "@/modules/verwaltung/ferien-abruf";
import { CurriculumForm } from "./curriculum-form";
import { GradesForm } from "./grades-form";
import { PeriodsForm, TimeGridForm } from "./periods-form";
import { RoomsSection } from "./raeume/rooms-section";
import { SchoolYearsForm } from "./school-years-form";
import { SubjectsForm } from "./subjects-form";

export const metadata: Metadata = { title: "Stammdaten" };

const AREAS = [
  { id: "jahrgaenge", label: "Jahrgänge" },
  { id: "faecher", label: "Fächer" },
  { id: "stundentafel", label: "Stundentafel" },
  { id: "zeitraster", label: "Zeitraster" },
  { id: "raeume", label: "Räume" },
  { id: "schuljahre", label: "Schuljahre" },
  { id: "ferien", label: "Ferien & Feiertage" },
] as const;

const timeFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const fmtDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));
type Area = (typeof AREAS)[number]["id"];

export default async function StammdatenPage({ searchParams }: { searchParams: Promise<{ bereich?: string; q?: string; art?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.school")) notFound();
  const sp = await searchParams;
  const area: Area = AREAS.find((a) => a.id === sp.bereich)?.id ?? "jahrgaenge";
  const db = await getDb();
  const [settings, levels, usage, subjects, used, periods] = await Promise.all([
    readSchoolSettings(db),
    listGradeLevels(db),
    db.select({ level: groups.gradeLevel, n: count() }).from(groups).where(isNotNull(groups.gradeLevel)).groupBy(groups.gradeLevel),
    area === "faecher" || area === "stundentafel" ? listSubjects(db) : [],
    area === "faecher" ? subjectUsage(db) : new Map<string, number>(),
    area === "zeitraster" ? listPeriods(db) : [],
  ]);
  const [years, yearGroups] = area === "schuljahre" || area === "ferien" ? await Promise.all([listSchoolYears(db), schoolYearUsage(db)]) : [[], new Map<string, number>()];
  const cal = area === "ferien" ? await loadSchoolCalendar(db) : null;
  const [holidayAuto, holidaySync] = area === "ferien" ? await Promise.all([holidayAutoEnabled(db), lastHolidaySync(db)]) : [false, null];
  const stateName = STATES.find((x) => x.code === settings.profile.state)?.name ?? settings.profile.state;
  // Ferien ab dem aktuellen Schuljahr; Feiertage des aktuellen Schuljahres (nur Werktage)
  const currentYear = years.find((y) => y.isCurrent);
  const shownClosures = cal ? cal.closures.filter((c) => !currentYear || c.endsOn >= currentYear.startsOn) : [];
  const holidays = cal && currentYear ? cal.between(currentYear.startsOn, currentYear.endsOn).filter((x) => x.kind === "feiertag" && weekdayMon0(x.startsOn) < 5) : [];
  const pauses = breaks(periods);
  const curriculum = area === "stundentafel" ? await listCurriculum(db) : [];
  const sek1 = levels.filter((l) => l.stage === "sek1");
  const template = gradeTemplate(settings.profile);
  const differs = template.length !== levels.length || template.some((t) => !levels.some((l) => l.level === t.level && l.code === t.code && l.stage === t.stage));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Stammdaten" />
      <nav aria-label="Stammdaten" className="flex flex-wrap gap-1">
        {AREAS.map((a) => (
          <Link
            key={a.id}
            href={`/verwaltung/stammdaten?bereich=${a.id}`}
            aria-current={a.id === area ? "page" : undefined}
            className={cn("rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2", a.id === area && "bg-accent-soft font-semibold text-accent-ink")}
          >
            {a.label}
          </Link>
        ))}
      </nav>

      {area === "jahrgaenge" && (
        <section aria-labelledby="jg" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="jg" className="font-display text-xl font-bold">
              Jahrgänge
            </h2>
            {differs && (
              <form action={applyGradeTemplateAction} className="flex items-center gap-3">
                <span className="text-sm text-muted">
                  Vorlage {formName(settings.profile.form, settings.profile.state)}: {template.map((t) => t.code).join(" · ")}
                </span>
                <Button type="submit">Vorlage übernehmen</Button>
              </form>
            )}
          </div>
          <GradesForm
            action={saveGradeLevelsAction}
            grades={levels.map((l) => ({ ...l, groups: usage.find((u) => u.level === l.level)?.n ?? 0 }))}
          />
        </section>
      )}

      {area === "faecher" && (
        <section aria-labelledby="fa" className="flex flex-col gap-4">
          <h2 id="fa" className="font-display text-xl font-bold">
            Fächer
          </h2>
          <SubjectsForm action={saveSubjectsAction} subjects={subjects.map((s) => ({ id: s.id, name: s.name, color: s.color, roomKind: s.roomKind, used: used.get(s.id) ?? 0 }))} />
        </section>
      )}

      {area === "stundentafel" && (
        <section aria-labelledby="st" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="st" className="font-display text-xl font-bold">
              Stundentafel
            </h2>
            <form action={applyCurriculumTemplateAction} className="flex items-center gap-3">
              <span className="text-sm text-muted">Vorlage {formName(settings.profile.form, settings.profile.state)} (ersetzt die Stunden aller Jahrgänge)</span>
              <Button type="submit">Vorlage übernehmen</Button>
            </form>
          </div>
          <p className="text-sm text-muted">
            Soll-Wochenstunden je Fach im Klassenunterricht der Sekundarstufe I. Die Vorlagen sind vereinfacht nach nordrhein-westfälischem Vorbild – bitte mit der gültigen
            Stundentafel des Landes abgleichen. Die Oberstufe plant über Kurse.
          </p>
          {sek1.length === 0 ? (
            <p className="text-sm text-muted">Keine Jahrgänge der Sekundarstufe I angelegt.</p>
          ) : (
            <CurriculumForm
              action={saveCurriculumAction}
              grades={sek1.map((l) => ({ level: l.level, code: l.code }))}
              subjects={subjects.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
              hours={Object.fromEntries(curriculum.map((c) => [`${c.gradeLevel}-${c.subjectId}`, c.hours]))}
            />
          )}
        </section>
      )}

      {area === "zeitraster" && (
        <section aria-labelledby="zr" className="flex flex-col gap-4">
          <h2 id="zr" className="font-display text-xl font-bold">
            Zeitraster
          </h2>
          <TimeGridForm action={applyTimeGridAction} grids={TIME_GRIDS.map((g) => ({ id: g.id, name: g.name }))} suggested={defaultTimeGrid(settings.profile).id} />
          <PeriodsForm action={savePeriodsAction} periods={periods.map((p) => ({ ...p, breakBefore: pauses.get(p.nr) ?? null }))} />
        </section>
      )}

      {area === "raeume" && <RoomsSection db={db} q={sp.q} art={sp.art} />}

      {area === "schuljahre" && (
        <section aria-labelledby="sj" className="flex flex-col gap-4">
          <h2 id="sj" className="font-display text-xl font-bold">
            Schuljahre
          </h2>
          <SchoolYearsForm action={saveSchoolYearsAction} years={years.map((y) => ({ ...y, groups: yearGroups.get(y.id) ?? 0 }))} />
        </section>
      )}

      {area === "ferien" && (
        <>
          <section aria-labelledby="fe" className="flex flex-col gap-4">
            <h2 id="fe" className="font-display text-xl font-bold">
              Ferien und unterrichtsfreie Tage
            </h2>
            <p className="text-sm text-muted">
              An diesen Tagen fallen alle Stunden aus; Stundenplan, Tagesleiste, Vertretungsplan, Klassenbuch und Klausurplan zeigen den Grund. In den Ferien sind Räume nicht buchbar, an
              unterrichtsfreien Tagen (z. B. pädagogischer Tag) schon. Ferientermine bitte mit dem Ferienkalender des Landes abgleichen.
            </p>
            <section aria-label="Automatischer Ferienabruf" className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-4 text-sm">
              <p>
                <strong>Automatischer Abruf:</strong> Die Ferien für {stateName} kommen {holidayAuto ? "jede Nacht" : "nur auf Knopfdruck"} aus der{" "}
                <a href={HOLIDAY_SOURCE_URL} className="underline" target="_blank" rel="noreferrer">
                  {HOLIDAY_SOURCE_LABEL}
                </a>{" "}
                (Daten unter {HOLIDAY_LICENSE}) – aktuelles und nächstes Schuljahr. Von Hand angelegte, geänderte oder gelöschte Einträge haben Vorrang und werden nicht
                überschrieben.
              </p>
              <p className="text-muted">
                {holidaySync
                  ? holidaySync.ok
                    ? `Letzter Abruf ${timeFmt.format(new Date(holidaySync.at))} Uhr: ${holidaySync.added} neu, ${holidaySync.updated} geändert, ${holidaySync.removed} entfernt${holidaySync.skipped.length ? `, ${holidaySync.skipped.length} übersprungen (${holidaySync.skipped.map((x) => `${x.name}: ${x.reason}`).join("; ")})` : ""}.`
                    : `Letzter Abruf ${timeFmt.format(new Date(holidaySync.at))} Uhr fehlgeschlagen: ${holidaySync.error}. Die Ferien blieben unverändert.`
                  : "Noch nicht abgerufen."}
              </p>
              <div className="flex flex-wrap gap-2">
                <form action={syncHolidaysAction}>
                  <Button type="submit" size="sm">
                    Jetzt abrufen
                  </Button>
                </form>
                <form action={setHolidayAutoAction}>
                  <input type="hidden" name="auto" value={holidayAuto ? "off" : "on"} />
                  <Button type="submit" size="sm" variant="ghost">
                    {holidayAuto ? "Nächtlichen Abruf ausschalten" : "Nächtlichen Abruf einschalten"}
                  </Button>
                </form>
              </div>
            </section>
            <ClosuresForm action={saveClosuresAction} closures={shownClosures.map((c) => ({ ...c }))} />
          </section>
          <section aria-labelledby="ft" className="flex flex-col gap-3">
            <h2 id="ft" className="font-display text-xl font-bold">
              Feiertage {currentYear ? `im Schuljahr ${currentYear.name}` : ""}
            </h2>
            <p className="text-sm text-muted">
              Werden für {STATES.find((x) => x.code === cal?.state)?.name} automatisch berechnet (Bundesland unter Verwaltung → Schule). Feiertage, die nur in einzelnen Gemeinden gelten, als
              unterrichtsfreien Tag eintragen.
            </p>
            {holidays.length === 0 ? (
              <p className="text-sm text-muted">Kein aktuelles Schuljahr gepflegt.</p>
            ) : (
              <ul aria-label="Feiertage" className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {holidays.map((h) => (
                  <li key={h.startsOn} className="flex justify-between gap-3 border-b border-border py-1.5">
                    <span>{h.name}</span>
                    <span className="text-muted tabular-nums">{fmtDay(h.startsOn)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
