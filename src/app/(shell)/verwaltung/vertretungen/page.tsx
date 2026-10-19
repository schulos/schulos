import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { applySuggestionAction, cancelReleasedAction, createAbsenceAction, deleteAbsenceAction, deleteSubstitutionAction, publishDayAction, saveSubstitutionAction } from "@/modules/stundenplan/actions";
import { dayRelease, draftDays, openDrafts } from "@/modules/stundenplan/freigabe";
import { ABSENCE_LABELS, GROUP_REASONS, needsOn, TEACHER_REASONS } from "@/modules/stundenplan/abwesenheit";
import { slotDisplay } from "@/modules/stundenplan/display";
import { plannableGroups, teacherOptions } from "@/modules/stundenplan/manage";
import { listSlots, timetableMasterData, type PlanTarget } from "@/modules/stundenplan/service";
import { planDays, substitutionsOn, teacherAvailability } from "@/modules/stundenplan/vertretung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import Link from "next/link";
import { suggestSubstitutes } from "@/modules/stundenplan/vorschlaege";
import { materialsFor } from "@/modules/stundenplan/selbstmeldung";
import { AbsenceForm } from "./absence-form";
import { SubstitutionForm } from "./substitution-form";

export const metadata: Metadata = { title: "Vertretungen" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const KIND_LABEL = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung" } as const;

export default async function VertretungenPage({ searchParams }: { searchParams: Promise<{ datum?: string; lehrkraft?: string; gruppe?: string; fehler?: string; veroeffentlicht?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.substitute")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  const today = toBerlinDate(new Date());
  const shown = planDays(today, cal);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : shown[0];
  const [teachers, groupList, master, changes, needs, release, drafts, shownChanges, shownDrafts] = await Promise.all([
    teacherOptions(db),
    plannableGroups(db),
    timetableMasterData(db),
    substitutionsOn(db, [date], { drafts: true }),
    needsOn(db, date),
    dayRelease(db, date),
    openDrafts(db, today),
    substitutionsOn(db, shown, { drafts: true }),
    draftDays(db, shown),
  ]);
  const notified = /^\d+$/.test(sp.veroeffentlicht ?? "") ? Number(sp.veroeffentlicht) : null;

  const target: PlanTarget | null = sp.lehrkraft ? { kind: "teacher", id: sp.lehrkraft } : sp.gruppe ? { kind: "group", id: sp.gruppe } : null;
  // nur eigene Stunden der Lehrkraft/Gruppe – übernommene Vertretungen werden bei der Original-Stunde gepflegt
  const lessons = target ? (await listSlots(db, target, date, addDays(date, 1), { drafts: true })).filter((s) => s.perspective !== "covering") : [];
  const [availability, suggestions] = await Promise.all([
    Promise.all(lessons.map((l) => teacherAvailability(db, l.lessonId, date))),
    Promise.all(lessons.map((l) => (l.change?.kind === "substitute" || l.change?.kind === "cancel" ? Promise.resolve([]) : suggestSubstitutes(db, l.lessonId, date)))),
  ]);
  const here = `/verwaltung/vertretungen?datum=${date}${sp.lehrkraft ? `&lehrkraft=${sp.lehrkraft}` : ""}${sp.gruppe ? `&gruppe=${sp.gruppe}` : ""}`;
  const openCount = needs.open.filter((o) => o.status === "open").length;
  // Q5-12: „Material liegt vor“ je offener Stunde
  const materials = await materialsFor(db, perms, needs.open.map((o) => ({ lessonId: o.lessonId, date })));
  const roomOptions = master.rooms.map((r) => ({ id: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` }));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Verwaltung"
        title="Vertretungen"
        actions={
          <Button asChild>
            <Link href="/verwaltung/vertretungen/statistik">Statistik</Link>
          </Button>
        }
      />
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      <nav aria-label="Tage im Vertretungsplan" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Im Vertretungsplan:</span>
        {[...new Set([...shown, ...drafts])].sort().map((d) => {
          const n = shownChanges.filter((c) => c.date === d).length;
          const draft = shownDrafts.has(d) || drafts.includes(d);
          return (
            <Link
              key={d}
              href={`/verwaltung/vertretungen?datum=${d}`}
              aria-current={d === date ? "date" : undefined}
              className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 hover:border-border-strong aria-[current=date]:border-accent"
            >
              <span className="font-medium">{shortDay.format(fromBerlinLocal(d))}</span>
              {shown.includes(d) && <span className="text-muted">{n === 0 ? "keine Änderungen" : n === 1 ? "1 Änderung" : `${n} Änderungen`}</span>}
              {draft && <Badge tone="warn">Entwurf</Badge>}
            </Link>
          );
        })}
      </nav>
      {notified !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Veröffentlicht{notified > 0 ? ` – ${notified === 1 ? "1 Person hat" : `${notified} Personen haben`} eine Nachricht bekommen.` : "."}
        </p>
      )}
      {release.draft ? (
        <Card aria-label="Entwurf" className="gap-3 border-warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Entwurf – noch nicht veröffentlicht</h2>
              <p className="text-sm text-muted">
                Schüler:innen, Eltern, Lehrkräfte und die Monitore sehen die Änderungen vom {longDay.format(fromBerlinLocal(date))} erst nach dem
                Veröffentlichen. Dann bekommt jede betroffene Person eine Nachricht mit allen Änderungen des Tages; spätere Änderungen gelten sofort.
              </p>
            </div>
            <form action={publishDayAction.bind(null, date)}>
              <Button type="submit" variant="primary">
                Tag veröffentlichen
              </Button>
            </form>
          </div>
        </Card>
      ) : (
        release.mode === "freigabe" && (
          <p aria-label="Freigabe" className="text-sm text-muted">
            {changes.length > 0 || release.publishedAt
              ? "Dieser Tag ist veröffentlicht – weitere Änderungen gelten sofort und melden sich bei den Betroffenen."
              : "Vertretungsplan mit Freigabe: Die erste Änderung an diesem Tag legt einen Entwurf an, den du danach veröffentlichst."}
          </p>
        )
      )}
      <Card aria-labelledby="absence-title" className="gap-3">
        <h2 id="absence-title" className="text-base font-semibold">
          Abwesenheit eintragen
        </h2>
        <p className="-mt-2 text-sm text-muted">
          Fehlt eine Lehrkraft, werden ihre Stunden offen. Fehlt eine Klasse (Exkursion, Praktikum), entfallen ihre Stunden und die Lehrkräfte sind frei für Vertretungen.
        </p>
        <AbsenceForm
          action={createAbsenceAction}
          date={date}
          teachers={teachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.name}` }))}
          groups={groupList.map((g) => ({ value: g.id, label: g.name }))}
          periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))}
          teacherReasons={TEACHER_REASONS.map((r) => ({ value: r, label: ABSENCE_LABELS[r] }))}
          groupReasons={GROUP_REASONS.map((r) => ({ value: r, label: ABSENCE_LABELS[r] }))}
        />
      </Card>
      <form className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[11rem_1fr_1fr_auto]" aria-label="Stunden wählen">
        <Input type="date" name="datum" defaultValue={date} aria-label="Datum" required />
        <Select name="lehrkraft" defaultValue={sp.lehrkraft ?? ""} aria-label="Lehrkraft (z. B. erkrankt)">
          <option value="">Lehrkraft (z. B. erkrankt) …</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} – {t.name}
            </option>
          ))}
        </Select>
        <Select name="gruppe" defaultValue={sp.gruppe ?? ""} aria-label="oder Klasse/Kurs">
          <option value="">oder Klasse/Kurs …</option>
          {(["klasse", "kurs", "ag"] as const).map((kind) => (
            <optgroup key={kind} label={GROUP_KIND_LABELS[kind]}>
              {groupList
                .filter((g) => g.kind === kind)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        <Button type="submit">Anzeigen</Button>
      </form>

      <section aria-labelledby="needs-title" className="flex flex-col gap-3">
        <h2 id="needs-title" className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
          Vertretungsbedarf am {longDay.format(fromBerlinLocal(date))}
          {openCount > 0 && <Badge tone="warn">{openCount} offen</Badge>}
        </h2>
        {needs.absences.length === 0 ? (
          <p className="text-sm text-muted">Für diesen Tag ist keine Abwesenheit eingetragen.</p>
        ) : (
          <>
            <ul aria-label="Abwesenheiten" className="flex flex-wrap gap-2">
              {needs.absences.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded-xl border border-border bg-surface py-1 pr-1 pl-3 text-sm">
                  <span className="font-semibold">{a.label}</span>
                  <span className="text-muted">
                    {ABSENCE_LABELS[a.reason]}
                    {a.fromPeriod !== null && ` · ${a.fromPeriod === a.toPeriod ? `${a.fromPeriod}.` : `${a.fromPeriod}.–${a.toPeriod}.`} Std.`}
                    {a.startsOn !== a.endsOn && ` · bis ${a.endsOn.slice(8)}.${a.endsOn.slice(5, 7)}.`}
                    {a.note && ` · ${a.note}`}
                    {a.selfReported && " · selbst gemeldet"}
                  </span>
                  <form action={deleteAbsenceAction.bind(null, a.id, date)}>
                    <Button type="submit" size="sm" variant="ghost" aria-label={`Abwesenheit ${a.label} aufheben`}>
                      Aufheben
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            {needs.open.length > 0 && (
              <Table>
                <caption className="sr-only">Offene Stunden abwesender Lehrkräfte</caption>
                <thead>
                  <tr>
                    <th>Std.</th>
                    <th>Klasse</th>
                    <th>Fach</th>
                    <th>Lehrkraft</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Aktion</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {needs.open.map((o) => (
                    <tr key={o.lessonId}>
                      <td className="tabular-nums">{o.periodNr}.</td>
                      <td className="font-medium">{o.groupName}</td>
                      <td>{o.subjectName}</td>
                      <td>{o.teacherCode}</td>
                      <td>
                        <Badge tone={o.status === "open" ? "warn" : "success"}>{o.status === "open" ? "offen" : KIND_LABEL[o.status]}</Badge>
                        {o.substituteAbsent && <span className="ml-2 text-xs text-muted">Vertretung durch {o.substituteAbsent} fällt aus</span>}
                        {materials.has(`${o.lessonId}:${date}`) && (
                          <Link href={`/stundenplan/material/${materials.get(`${o.lessonId}:${date}`)!.id}`} className="ml-2 text-xs font-medium text-accent-ink hover:underline">
                            Material liegt vor
                          </Link>
                        )}
                      </td>
                      <td className="text-right">
                        <Button asChild size="sm">
                          <a href={`/verwaltung/vertretungen?datum=${date}&lehrkraft=${o.teacherId}#lessons-title`}>{o.status === "open" ? "Vertretung eintragen" : "Ändern"}</a>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {needs.released.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Freisetzungen (Klasse abwesend, Lehrkraft frei)</h3>
                  {needs.released.some((r) => !r.cancelled) && (
                    <form action={cancelReleasedAction.bind(null, date)}>
                      <Button type="submit" size="sm">
                        Entfall für alle eintragen
                      </Button>
                    </form>
                  )}
                </div>
                <Table>
                  <caption className="sr-only">Freisetzungen</caption>
                  <thead>
                    <tr>
                      <th>Std.</th>
                      <th>Klasse</th>
                      <th>Fach</th>
                      <th>frei</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needs.released.map((r) => (
                      <tr key={r.lessonId}>
                        <td className="tabular-nums">{r.periodNr}.</td>
                        <td className="font-medium">{r.groupName}</td>
                        <td>{r.subjectName}</td>
                        <td>{r.teacherCode ?? "–"}</td>
                        <td>
                          <Badge tone={r.cancelled ? "neutral" : "warn"}>{r.cancelled ? "Entfall eingetragen" : "Entfall fehlt"}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </>
        )}
      </section>

      {target && (
        <section aria-labelledby="lessons-title" className="flex flex-col gap-3">
          <h2 id="lessons-title" className="font-display text-xl font-bold">
            Stunden am {longDay.format(fromBerlinLocal(date))}
          </h2>
          {lessons.length === 0 ? (
            <EmptyState title="An diesem Tag keine Stunden" />
          ) : (
            lessons.map((l, i) => {
              const d = slotDisplay(l, target.kind === "teacher" ? "teacher" : "group");
              const existing = changes.find((c) => c.lessonId === l.lessonId);
              const label = `${l.periodNr}. Std · ${l.subjectName} · ${l.groupName}`;
              return (
                <Card key={l.lessonId} className="gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="h-9 w-1.5 rounded-full" style={{ background: l.color }} />
                      <span className="flex flex-col leading-tight">
                        <span className="font-semibold">
                          {l.periodNr}. Std · {l.subjectName}
                        </span>
                        <span className="text-sm text-muted">{[l.groupName, l.teacherCode, l.roomId && `R ${l.roomId}`].filter(Boolean).join(" · ")}</span>
                      </span>
                    </div>
                    {d.tag && <Badge tone={d.tone === "sub" ? "warn" : "neutral"}>{d.tag}</Badge>}
                  </div>
                  {suggestions[i]!.length > 0 && (
                    <div aria-label={`Vorschläge: ${label}`} role="group" className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3">
                      <span className="text-xs font-semibold tracking-wide text-muted uppercase">Vorschläge</span>
                      <ol className="flex flex-col gap-1.5">
                        {suggestions[i]!.slice(0, 3).map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <form action={applySuggestionAction.bind(null, l.lessonId, date, c.id, here)}>
                              <Button type="submit" size="sm" aria-label={`${c.code ?? c.name} übernehmen: ${label}`}>
                                {c.code ?? c.name} übernehmen
                              </Button>
                            </form>
                            <Badge tone={c.score > 0 ? "success" : "neutral"}>{c.score > 0 ? `+${c.score}` : c.score} Punkte</Badge>
                            <span className="text-muted">{c.reasons.map((r) => `${r.label} (${r.points > 0 ? "+" : ""}${r.points})`).join(" · ")}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <SubstitutionForm
                    action={saveSubstitutionAction}
                    removeAction={existing ? deleteSubstitutionAction.bind(null, existing.id) : undefined}
                    lessonId={l.lessonId}
                    date={date}
                    label={label}
                    initial={{
                      kind: existing?.kind ?? "substitute",
                      substituteId: l.change?.substituteId ?? "",
                      roomId: l.change?.roomId ?? "",
                      note: l.change?.note ?? "",
                    }}
                    teachers={availability[i]!.map((t) => ({ id: t.id, label: `${t.code} – ${t.name}`, free: t.free }))}
                    rooms={roomOptions}
                  />
                </Card>
              );
            })
          )}
        </section>
      )}

      <section aria-labelledby="day-title" className="flex flex-col gap-3">
        <h2 id="day-title" className="font-display text-xl font-bold">
          Alle Änderungen am {longDay.format(fromBerlinLocal(date))}
        </h2>
        {changes.length === 0 ? (
          <EmptyState title="Noch keine Änderungen">Wähle oben eine Lehrkraft oder Klasse, um Vertretungen einzutragen.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Klasse</th>
                <th>Std.</th>
                <th>Fach</th>
                <th>Art</th>
                <th>Vertretung · Raum</th>
                <th>Hinweis</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium whitespace-nowrap">{c.groupName}</td>
                  <td className="tabular-nums">{c.periodNr}.</td>
                  <td className="whitespace-nowrap">
                    {c.subjectName} <span className="text-muted">({c.teacherCode})</span>
                  </td>
                  <td>
                    <Badge tone={c.kind === "cancel" ? "neutral" : "warn"}>{KIND_LABEL[c.kind]}</Badge>
                  </td>
                  <td className="whitespace-nowrap">{[c.substituteCode, c.newRoomId && `R ${c.newRoomId}`].filter(Boolean).join(" · ") || "–"}</td>
                  <td className="text-muted">{c.note}</td>
                  <td className="text-right">
                    <form action={deleteSubstitutionAction.bind(null, c.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Aufheben: ${c.groupName} ${c.periodNr}. Std`}>
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
    </main>
  );
}
