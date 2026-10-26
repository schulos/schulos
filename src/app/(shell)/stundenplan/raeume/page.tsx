import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { applyAlternativeRoomAction, createRoomBlockAction, deleteRoomBlockAction } from "@/modules/stundenplan/actions";
import { affectedLessons, listRoomBlocks, ROOM_BLOCK_LABELS } from "@/modules/stundenplan/raumsperren";
import { getDb } from "@/core/db/client";
import { ROOM_BLOCK_REASONS, ROOM_EQUIPMENT, ROOM_KINDS, type RoomEquipment, type RoomKind } from "@/core/db/schema";
import { ROOM_EQUIPMENT_LABELS, ROOM_KIND_LABELS } from "@/core/labels";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, fromBerlinLocal, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { bookableRooms, listRooms, occupancyOn, searchRooms, weekUtilization, type Occupancy } from "@/modules/stundenplan/raeume";
import { seesAllPlans, timetableMasterData } from "@/modules/stundenplan/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { RoomBlockForm } from "./block-form";

export const metadata: Metadata = { title: "Räume" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

type Search = {
  ansicht?: string;
  datum?: string;
  von?: string;
  bis?: string;
  plaetze?: string;
  art?: string;
  ausstattung?: string | string[];
  barrierefrei?: string;
  gebaeude?: string;
  fehler?: string;
};

const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function OccCell({ o }: { o: Occupancy | undefined }) {
  if (!o) return <span className="sr-only">frei</span>;
  return (
    <span
      className={cn(
        "block truncate rounded-md px-1.5 py-1 text-xs",
        o.kind === "lesson" && "bg-surface-2",
        o.kind === "lesson" && o.moved && "bg-warn-soft text-warn",
        o.kind === "booking" && "bg-accent-soft text-accent-ink",
        o.kind === "blocked" && "bg-danger-soft text-danger",
      )}
      title={o.label}
    >
      {o.label}
    </span>
  );
}

/** Raumsuche und Belegung aller Räume (Lehrkräfte, Verwaltung, Gebäude & Technik). */
export default async function RaeumePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  // SP-05 (FEINSCHLIFF L-01): alle Beschäftigten (auch Personal/Hausmeisterei und Beratung, Q5-08) und wer plant – statt fester
  // Rollenliste mit `gebaeude.manage`-Ausnahme. Schüler:innen und Eltern nicht (Belegung zeigt Lehrkraftkürzel).
  if (!seesAllPlans(perms)) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const cal = await loadSchoolCalendar(db);
  const date = YMD.test(sp.datum ?? "") ? sp.datum! : weekdayMon0(today) >= 5 ? cal.nextSchoolDay(today) : today;
  const [master, roomList, bookable, { occupancy, closed }] = await Promise.all([timetableMasterData(db), listRooms(db), bookableRooms(db), occupancyOn(db, date)]);
  const periodNrs = master.periods.map((p) => p.nr);
  const canManage = hasPermission(perms, "stundenplan.substitute"); // SP-02: Raumsperren = Tagesgeschäft
  // „Buchen“ nur, wer buchen darf – sonst führte der Knopf für die Hausmeisterei auf eine 404 (Code-Review Gate 4a N8)
  const canBook = hasPermission(perms, "buchungen.book") && (await moduleOn("buchungen"));
  // „Mangel melden“ mit vorbelegtem Raum (Gebäude & Technik, P4-13)
  const canReportDefect = hasPermission(perms, "gebaeude.report") && (await moduleOn("gebaeude"));
  // Raumdaten pflegen: Link nur mit Stammdaten-Recht (die Zielseite verlangt `verwaltung.school`)
  const canEditRoom = hasPermission(perms, "verwaltung.school");
  const editHref = (roomId: string) => `/verwaltung/stammdaten/raeume/${encodeURIComponent(roomId)}`;
  const reportHref = (roomId: string) => `/gebaeude/melden?raum=${encodeURIComponent(roomId)}`;
  const occupancyView = sp.ansicht === "belegung";
  const blocksView = canManage && sp.ansicht === "sperrungen";
  const dayLabel = longDay.format(fromBerlinLocal(date));

  const tabs = (
    <nav aria-label="Ansicht" className="flex gap-2">
      {[
        { key: "suche", label: "Raumsuche", href: `/stundenplan/raeume?datum=${date}` },
        { key: "belegung", label: "Belegung", href: `/stundenplan/raeume?ansicht=belegung&datum=${date}` },
        ...(canManage ? [{ key: "sperrungen", label: "Sperrungen", href: "/stundenplan/raeume?ansicht=sperrungen" }] : []),
      ].map((t) => {
        const active = t.key === (blocksView ? "sperrungen" : occupancyView ? "belegung" : "suche");
        return (
          <Button key={t.key} asChild size="sm" variant={active ? "secondary" : "ghost"}>
            <Link href={t.href} aria-current={active ? "page" : undefined}>
              {t.label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );

  if (blocksView) {
    const [blocks, affected] = await Promise.all([listRoomBlocks(db, today), affectedLessons(db, today, 14)]);
    const fmtDay = (ymd: string) => new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ }).format(fromBerlinLocal(ymd));
    const open = affected.filter((a) => !a.resolved).length;
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplan" title="Räume" />
        {tabs}
        {sp.fehler && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {sp.fehler}
          </p>
        )}
        <section aria-labelledby="new-block" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
          <h2 id="new-block" className="text-base font-semibold">
            Raum sperren
          </h2>
          <RoomBlockForm
            action={createRoomBlockAction}
            today={today}
            rooms={roomList.map((r) => ({ value: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` }))}
            periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))}
            reasons={ROOM_BLOCK_REASONS.map((r) => ({ value: r, label: ROOM_BLOCK_LABELS[r] }))}
          />
        </section>
        <section aria-labelledby="blocks" className="flex flex-col gap-3">
          <h2 id="blocks" className="font-display text-xl font-bold">
            Laufende und geplante Sperrungen
          </h2>
          {blocks.length === 0 ? (
            <EmptyState title="Keine Sperrungen" />
          ) : (
            <Table>
              <caption className="sr-only">Raumsperrungen</caption>
              <thead>
                <tr>
                  <th>Raum</th>
                  <th>Zeitraum</th>
                  <th>Stunden</th>
                  <th>Grund</th>
                  <th>
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.id}>
                    <td className="font-semibold">{b.roomId}</td>
                    <td>{b.startsOn === b.endsOn ? fmtDay(b.startsOn) : `${fmtDay(b.startsOn)} – ${fmtDay(b.endsOn)}`}</td>
                    <td>{b.fromPeriod === null ? "ganzer Tag" : b.fromPeriod === b.toPeriod ? `${b.fromPeriod}.` : `${b.fromPeriod}.–${b.toPeriod}.`}</td>
                    <td>
                      {ROOM_BLOCK_LABELS[b.reason]}
                      {b.note && <span className="text-muted"> · {b.note}</span>}
                    </td>
                    <td className="text-right">
                      <form action={deleteRoomBlockAction.bind(null, b.id)}>
                        <Button type="submit" size="sm" variant="ghost" aria-label={`Sperrung ${b.roomId} aufheben`}>
                          Aufheben
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
        <section aria-labelledby="affected" className="flex flex-col gap-3">
          <h2 id="affected" className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
            Betroffene Stunden (nächste 14 Tage)
            {open > 0 && <Badge tone="warn">{open} ohne Ausweichraum</Badge>}
          </h2>
          {affected.length === 0 ? (
            <p className="text-sm text-muted">Keine Stunde liegt in einem gesperrten Raum.</p>
          ) : (
            <Table>
              <caption className="sr-only">Stunden in gesperrten Räumen</caption>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Std.</th>
                  <th>Stunde</th>
                  <th>Raum</th>
                  <th>Ausweichraum</th>
                </tr>
              </thead>
              <tbody>
                {affected.map((a) => (
                  <tr key={`${a.lessonId}-${a.date}`}>
                    <td className="whitespace-nowrap">{fmtDay(a.date)}</td>
                    <td className="tabular-nums">{a.periodNr}.</td>
                    <td>
                      {a.subjectName} · {a.groupName}
                      {a.teacherCode && <span className="text-muted"> ({a.teacherCode})</span>}
                    </td>
                    <td>
                      {a.roomId} <span className="text-xs text-muted">{ROOM_BLOCK_LABELS[a.block.reason]}</span>
                    </td>
                    <td>
                      {a.resolved ? (
                        <Badge tone="success">verlegt</Badge>
                      ) : a.suggestions.length === 0 ? (
                        <Badge tone="danger">kein Raum frei</Badge>
                      ) : (
                        <span className="flex flex-wrap gap-1.5">
                          {a.suggestions.map((r) => (
                            <form key={r.id} action={applyAlternativeRoomAction.bind(null, a.lessonId, a.date, r.id, ROOM_BLOCK_LABELS[a.block.reason])}>
                              <Button type="submit" size="sm" aria-label={`${a.subjectName} ${a.groupName} ${fmtDay(a.date)} ${a.periodNr}. Stunde nach ${r.id} verlegen`}>
                                → {r.id}
                                {r.capacity !== null && <span className="text-muted"> ({r.capacity})</span>}
                              </Button>
                            </form>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </main>
    );
  }

  if (occupancyView) {
    const buildings = [...new Set(roomList.map((r) => r.building ?? "").filter(Boolean))].sort();
    const building = buildings.find((b) => b === sp.gebaeude);
    const shown = roomList.filter((r) => !building || r.building === building);
    const util = await weekUtilization(db, mondayOf(date));
    const pct = (roomId: string) => (util.capacity ? Math.round(((util.used.get(roomId) ?? 0) / util.capacity) * 100) : 0);
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplan" title="Räume" />
        {tabs}
        <form className="flex flex-wrap items-end gap-3" aria-label="Tag wählen">
          <input type="hidden" name="ansicht" value="belegung" />
          <Field label="Tag">
            <Input type="date" name="datum" defaultValue={date} className="w-44" />
          </Field>
          {buildings.length > 0 && (
            <Field label="Gebäude">
              <Select name="gebaeude" defaultValue={building ?? ""} className="w-48">
                <option value="">alle</option>
                {buildings.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </Select>
            </Field>
          )}
          <Button type="submit">Anzeigen</Button>
        </form>
        <h2 className="font-display text-xl font-bold">Belegung am {dayLabel}</h2>
        {closed ? (
          <EmptyState title={closed}>An diesem Tag ist die Schule geschlossen.</EmptyState>
        ) : (
          <Table>
            <caption className="sr-only">Belegung aller Räume am {dayLabel}</caption>
            <thead>
              <tr>
                <th>Raum</th>
                <th className="text-right" title="belegte Stunden in dieser Woche">
                  Auslastung Woche
                </th>
                {master.periods.map((p) => (
                  <th key={p.nr} className="min-w-28">
                    {p.nr}.
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="text-left font-semibold whitespace-nowrap normal-case tracking-normal text-ink">
                    {r.id}
                    <span className="block text-xs font-normal normal-case text-muted">{ROOM_KIND_LABELS[r.kind]}</span>
                    {canReportDefect && (
                      <Link href={reportHref(r.id)} className="block text-xs font-medium normal-case text-accent-ink hover:underline" aria-label={`Mangel in Raum ${r.id} melden`}>
                        Mangel melden
                      </Link>
                    )}
                    {canEditRoom && (
                      <Link href={editHref(r.id)} className="block text-xs font-medium normal-case text-accent-ink hover:underline" aria-label={`Raum ${r.id} bearbeiten`}>
                        Bearbeiten
                      </Link>
                    )}
                  </th>
                  <td className="text-right tabular-nums">{pct(r.id)} %</td>
                  {master.periods.map((p) => (
                    <td key={p.nr} className="!px-1.5 !py-1.5">
                      <OccCell o={occupancy.get(r.id)?.get(p.nr)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </main>
    );
  }

  // ------------------------------------------------------------ Raumsuche
  const from = Number(sp.von) || 0;
  const to = Number(sp.bis) || from;
  const kind = ROOM_KINDS.find((k): k is RoomKind => k === sp.art) ?? null;
  const equipment = asList(sp.ausstattung).filter((e): e is RoomEquipment => (ROOM_EQUIPMENT as readonly string[]).includes(e));
  const minCapacity = Number(sp.plaetze) > 0 ? Number(sp.plaetze) : null;
  const searched = from > 0;
  const wanted = periodNrs.filter((p) => p >= from && p <= Math.max(from, to));
  const hits = searched && !closed ? searchRooms(roomList, occupancy, { periodNrs: wanted, minCapacity, kind, equipment, accessible: sp.barrierefrei === "1" }, periodNrs) : [];
  const periodLabel = wanted.length > 1 ? `${wanted[0]}.–${wanted.at(-1)}. Stunde` : `${from}. Stunde`;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplan" title="Räume" />
      {tabs}
      <form aria-label="Raumsuche" className="grid gap-4 rounded-card border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Tag">
          <Input type="date" name="datum" defaultValue={date} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="von Stunde">
            <Select name="von" defaultValue={sp.von ?? ""} required>
              <option value="">–</option>
              {master.periods.map((p) => (
                <option key={p.nr} value={p.nr}>
                  {p.nr}. ({p.startsAt})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="bis Stunde">
            <Select name="bis" defaultValue={sp.bis ?? ""}>
              <option value="">–</option>
              {master.periods.map((p) => (
                <option key={p.nr} value={p.nr}>
                  {p.nr}. ({p.endsAt})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Mindestens Plätze">
          <Input type="number" name="plaetze" min={1} max={500} defaultValue={sp.plaetze ?? ""} />
        </Field>
        <Field label="Raumart">
          <Select name="art" defaultValue={kind ?? ""}>
            <option value="">egal</option>
            {ROOM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ROOM_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="flex flex-col gap-2 sm:col-span-2 lg:col-span-3">
          <legend className="mb-1.5 text-sm font-medium">Ausstattung</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {ROOM_EQUIPMENT.map((e) => (
              <label key={e} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="ausstattung" value={e} defaultChecked={equipment.includes(e)} className="size-4 accent-[var(--accent)]" />
                {ROOM_EQUIPMENT_LABELS[e]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col justify-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="barrierefrei" value="1" defaultChecked={sp.barrierefrei === "1"} className="size-4 accent-[var(--accent)]" />
            barrierefrei
          </label>
          <Button type="submit" variant="primary">
            Freie Räume suchen
          </Button>
        </div>
      </form>

      {!searched ? (
        <EmptyState title="Welche Räume sind frei?">Tag und Stunde wählen, optional Plätze, Raumart und Ausstattung.</EmptyState>
      ) : closed ? (
        <EmptyState title={closed}>An diesem Tag ist die Schule geschlossen.</EmptyState>
      ) : (
        <section aria-labelledby="hits" className="flex flex-col gap-3">
          <h2 id="hits" className="font-display text-xl font-bold">
            {hits.length === 0 ? "Kein Raum frei" : `${hits.length} ${hits.length === 1 ? "Raum" : "Räume"} frei`} · {dayLabel}, {periodLabel}
          </h2>
          {hits.length === 0 && <p className="text-sm text-muted">Filter lockern (weniger Plätze, andere Raumart, kürzerer Zeitraum) oder in der Belegung nach einer Lücke schauen.</p>}
          {hits.length > 0 && (
            <Table>
              <caption className="sr-only">Freie Räume</caption>
              <thead>
                <tr>
                  <th>Raum</th>
                  <th>Art</th>
                  <th className="text-right">Plätze</th>
                  <th>Ausstattung</th>
                  <th className="text-right">frei am Tag</th>
                  <th>
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {hits.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="font-semibold">{r.id}</span>
                      {r.name !== r.id && <span className="text-muted"> · {r.name}</span>}
                      {(r.building || r.floor) && <span className="block text-xs text-muted">{[r.building, r.floor].filter(Boolean).join(", ")}</span>}
                    </td>
                    <td>{ROOM_KIND_LABELS[r.kind]}</td>
                    <td className="text-right tabular-nums">{r.capacity ?? "–"}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {r.equipment.map((e) => (
                          <Badge key={e}>{ROOM_EQUIPMENT_LABELS[e]}</Badge>
                        ))}
                        {r.accessible && <Badge tone="soft">barrierefrei</Badge>}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {r.freePeriods} von {periodNrs.length} Std.
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {canEditRoom && (
                        <Button asChild size="sm" variant="ghost">
                          <Link href={editHref(r.id)} aria-label={`Raum ${r.id} bearbeiten`}>
                            Bearbeiten
                          </Link>
                        </Button>
                      )}
                      {canReportDefect && (
                        <Button asChild size="sm" variant="ghost">
                          <Link href={reportHref(r.id)} aria-label={`Mangel in Raum ${r.id} melden`}>
                            Mangel melden
                          </Link>
                        </Button>
                      )}
                      {canBook && bookable.has(r.id) && (
                        <Button asChild size="sm">
                          <Link href={`/buchungen?ressource=${bookable.get(r.id)}&woche=${date}`}>Buchen</Link>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </main>
  );
}
