import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Laptop, MapPin } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, isoWeek, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { bookAction, cancelBookingAction } from "@/modules/buchungen/actions";
import { bookingAccess, listResources, myBookings, resourceWeek } from "@/modules/buchungen/service";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { getModule } from "@/modules";
import { sendableGroups } from "@/modules/elternbriefe/service";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { BookingForm } from "./booking-form";

export const metadata: Metadata = { title: "Buchungen" };

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: TZ });
const dayDate = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const fmt = (f: Intl.DateTimeFormat, ymd: string) => f.format(fromBerlinLocal(ymd));

/** Lesend ohne Formular (keine Buchen-/Stornieren-Knöpfe), sonst das Wochenformular. */
function MaybeForm({ readOnly, formKey, action, groups, children }: { readOnly: boolean; formKey: string; action: Parameters<typeof BookingForm>[0]["action"]; groups: { id: string; name: string }[]; children: React.ReactNode }) {
  if (readOnly) return <>{children}</>;
  return (
    <BookingForm key={formKey} action={action} groups={groups}>
      {children}
    </BookingForm>
  );
}

export default async function BuchungenPage({ searchParams }: { searchParams: Promise<{ ressource?: string; woche?: string }> }) {
  const { user, perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  // Q5-08b: Hausmeisterei (gebaeude.manage) sieht die Belegung nur lesend
  const gebaeude = getModule("gebaeude");
  const access = bookingAccess(perms, !!gebaeude && isEnabled(gebaeude, await loadModuleStates(db)));
  if (!access) notFound();
  const readOnly = access === "read";
  const today = toBerlinDate(new Date());
  const thisWeek = weekdayMon0(today) >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(sp.woche ?? "") ? mondayOf(sp.woche!) : thisWeek;
  const days = WEEKDAYS.map((_, i) => addDays(monday, i));
  const [resources, mine, master, groupList] = await Promise.all([
    listResources(db),
    readOnly ? Promise.resolve([]) : myBookings(db, user.id, today),
    timetableMasterData(db),
    readOnly ? Promise.resolve([]) : sendableGroups(db, perms),
  ]);
  const resource = resources.find((r) => r.id === sp.ressource) ?? resources[0];
  const week = resource ? await resourceWeek(db, resource.id, monday) : new Map();
  const href = (q: Record<string, string>) => `/buchungen?${new URLSearchParams({ ...(resource ? { ressource: resource.id } : {}), woche: monday, ...q })}`;
  const lastPeriod = resource?.roomId ? master.periods.length : 7;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Organisation"
        title="Buchungen"
        actions={
          hasPermission(perms, "buchungen.manage") && (
            <Button asChild>
              <Link href="/buchungen/ressourcen">Ressourcen verwalten</Link>
            </Button>
          )
        }
      />
      {resources.length === 0 ? (
        <EmptyState title="Keine buchbaren Ressourcen">Die Verwaltung legt Räume und Geräte an.</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <aside className="flex flex-col gap-5">
            <nav aria-label="Ressourcen" className="flex flex-col gap-3">
              {(["room", "device"] as const).map((kind) => (
                <div key={kind} className="flex flex-col gap-1">
                  <span className="text-xs font-semibold tracking-wide text-muted uppercase">{kind === "room" ? "Räume" : "Geräte"}</span>
                  {resources
                    .filter((r) => r.kind === kind)
                    .map((r) => (
                      <Link
                        key={r.id}
                        href={`/buchungen?ressource=${r.id}&woche=${monday}`}
                        aria-current={r.id === resource?.id ? "page" : undefined}
                        className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent-ink"
                      >
                        {kind === "room" ? <MapPin aria-hidden className="size-4" /> : <Laptop aria-hidden className="size-4" />}
                        {r.name}
                      </Link>
                    ))}
                </div>
              ))}
            </nav>
            {!readOnly && (
            <section aria-labelledby="meine" className="flex flex-col gap-2">
              <h2 id="meine" className="text-xs font-semibold tracking-wide text-muted uppercase">
                Meine Buchungen
              </h2>
              {mine.length === 0 ? (
                <p className="text-sm text-muted">keine</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {mine.slice(0, 8).map((b) => (
                    <li key={b.id}>
                      <Link href={`/buchungen?ressource=${b.resourceId}&woche=${mondayOf(b.date)}`} className="hover:underline">
                        {fmt(dayDate, b.date)}, {b.periodNr}. Std · {b.resourceName}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            )}
          </aside>

          {resource && (
            <section aria-labelledby="woche" className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1">
                <Button asChild variant="ghost" size="icon">
                  <Link href={href({ woche: addDays(monday, -7) })} aria-label="Vorige Woche">
                    <ChevronLeft aria-hidden />
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="icon">
                  <Link href={href({ woche: addDays(monday, 7) })} aria-label="Nächste Woche">
                    <ChevronRight aria-hidden />
                  </Link>
                </Button>
                <h2 id="woche" className="ml-1 font-semibold">
                  {resource.name}
                  <span className="font-normal text-muted">
                    {" "}
                    · KW {isoWeek(monday)} · {fmt(shortDate, monday)} – {fmt(shortDate, days[4]!)}
                  </span>
                </h2>
              </div>
              {resource.description && <p className="text-sm text-muted">{resource.description}</p>}
              {readOnly && <p className="text-sm text-muted">Nur lesen – gebucht wird von Lehrkräften und Verwaltung.</p>}
              <MaybeForm readOnly={readOnly} formKey={`${resource.id}:${monday}`} action={bookAction.bind(null, resource.id)} groups={groupList.map((g) => ({ id: g.id, name: g.name }))}>
                <div className="overflow-x-auto rounded-card border border-border bg-surface">
                  <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className="w-16 px-3 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">Std.</th>
                        {days.map((d, i) => (
                          <th key={d} className="px-2 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                            {WEEKDAYS[i]} <span className="font-normal normal-case">{fmt(shortDate, d)}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {master.periods
                        .filter((p) => p.nr <= lastPeriod)
                        .map((p) => (
                          <tr key={p.nr} className="border-t border-border">
                            <td className="px-3 py-2 align-top">
                              <span className="font-semibold">{p.nr}.</span>
                              <span className="block text-xs text-muted tabular-nums">{p.startsAt}</span>
                            </td>
                            {days.map((d) => {
                              const s = week.get(`${d}:${p.nr}`);
                              const past = d < today;
                              return (
                                <td key={d} className="px-1.5 py-1.5 align-top">
                                  {s?.kind === "closed" ? (
                                    <span className="flex min-h-12 flex-col justify-center rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted">{s.label}</span>
                                  ) : s?.kind === "lesson" ? (
                                    <span className="flex min-h-12 flex-col justify-center rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted">Unterricht · {s.label}</span>
                                  ) : s?.kind === "booked" ? (
                                    <span
                                      data-booked
                                      className={cn("flex min-h-12 flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-xs", s.byId === user.id ? "border-accent bg-accent-soft" : "border-border bg-surface")}
                                    >
                                      <span className="font-semibold">{s.byId === user.id ? "Meine Buchung" : s.byName}</span>
                                      {/* lesend ohne Notiz (Freitext der buchenden Person), siehe QUESTIONS Q-08b-1 */}
                                      {(s.groupName || (!readOnly && s.note)) && <span className="text-muted">{[s.groupName, readOnly ? null : s.note].filter(Boolean).join(" · ")}</span>}
                                      {!readOnly && (s.byId === user.id || hasPermission(perms, "buchungen.manage")) && !past && (
                                        <button
                                          type="submit"
                                          formAction={cancelBookingAction.bind(null, s.bookingId)}
                                          formNoValidate
                                          className="w-fit text-xs font-medium text-danger hover:underline"
                                          aria-label={`Stornieren: ${fmt(dayDate, d)}, ${p.nr}. Stunde`}
                                        >
                                          Stornieren
                                        </button>
                                      )}
                                    </span>
                                  ) : past ? (
                                    <span className="block min-h-12" />
                                  ) : readOnly ? (
                                    <span className="flex min-h-12 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted">frei</span>
                                  ) : (
                                    <button
                                      type="submit"
                                      name="slot"
                                      value={`${d}:${p.nr}`}
                                      aria-label={`Buchen: ${fmt(dayDate, d)}, ${p.nr}. Stunde`}
                                      className="flex min-h-12 w-full items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted transition hover:border-accent hover:text-accent-ink"
                                    >
                                      frei
                                    </button>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </MaybeForm>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
