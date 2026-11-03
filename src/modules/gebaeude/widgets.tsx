import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { WidgetDef } from "@/core/widgets";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { OPEN_STATUSES, STATUS_LABELS } from "./labels";
import { toBerlinDate } from "@/core/time";
import { inspectionSummary } from "./pruefungen";
import { OVERDUE_DAYS, myOpenTickets, openSummary, overdueTickets, placeLabel } from "./service";
import { todayInHouse } from "./heute";
import { formatLoanDay, myLoans } from "./leihe";
import { blockLabel } from "@/modules/stundenplan/raumsperren";
import { EVENT_STATUS_LABELS } from "./labels";
import { eventPlace, openEventCount, setupText } from "./veranstaltungen";

/** Für Melder:innen: eigene offene Meldungen mit Status. */
async function MeineMeldungen({ current }: { current: CurrentUser }) {
  const items = await myOpenTickets(await getDb(), current.perms);
  return (
    <Card>
      <CardHeader title="Meine Meldungen" action={{ href: "/gebaeude/melden", label: "Mangel melden" }} />
      {items.length === 0 ? (
        <p className="text-sm text-muted">Keine offenen Meldungen.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((t) => (
            <li key={t.id}>
              <Link href={`/gebaeude/${t.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="truncate text-xs text-muted">
                    {t.number} · {placeLabel(t)}
                  </span>
                </span>
                <Badge tone={t.status === "neu" ? "warn" : "soft"}>{STATUS_LABELS[t.status]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Für die Bearbeitung: offene Meldungen je Status, Gefahr und überfällige (länger als 14 Tage offen). */
async function Offen({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const [summary, overdue, checks, events] = await Promise.all([
    openSummary(db),
    overdueTickets(db, current.perms),
    inspectionSummary(db, current.perms, toBerlinDate(new Date())),
    openEventCount(db),
  ]);
  return (
    <Card>
      <CardHeader title="Gebäude & Technik: offen" action={{ href: "/gebaeude", label: "Zum Board" }} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {OPEN_STATUSES.map((s) => (
          <Link key={s} href="/gebaeude" className="flex flex-col rounded-xl bg-surface-2 px-3 py-2.5 hover:ring-1 hover:ring-border-strong">
            <span className="font-display text-2xl font-bold tracking-tight">{summary.byStatus[s]}</span>
            <span className="text-xs text-muted">{STATUS_LABELS[s]}</span>
          </Link>
        ))}
      </div>
      {summary.danger > 0 && (
        <Link href="/gebaeude?prioritaet=gefahr" className="text-sm font-semibold text-danger hover:underline">
          {summary.danger === 1 ? "1 Meldung" : `${summary.danger} Meldungen`} mit Gefahr
        </Link>
      )}
      {(checks.overdue > 0 || checks.due > 0) && (
        <Link href={checks.overdue ? "/gebaeude/pruefungen?stand=ueberfaellig" : "/gebaeude/pruefungen?stand=faellig"} className="text-sm font-semibold hover:underline">
          Prüfungen: {[checks.overdue ? `${checks.overdue} überfällig` : null, checks.due ? `${checks.due} bald fällig` : null].filter(Boolean).join(", ")}
        </Link>
      )}
      {events > 0 && (
        <Link href="/gebaeude/veranstaltungen" className="text-sm font-semibold hover:underline">
          Veranstaltungen: {events === 1 ? "1 Anmeldung" : `${events} Anmeldungen`} zu bestätigen
        </Link>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Überfällig (über {OVERDUE_DAYS} Tage offen)</span>
        {overdue.length === 0 ? (
          <p className="text-sm text-muted">Nichts überfällig.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {overdue.map((t) => (
              <li key={t.id}>
                <Link href={`/gebaeude/${t.id}`} className="flex justify-between gap-3 hover:underline">
                  <span className="truncate">{t.title}</span>
                  <span className="shrink-0 text-muted">{t.number}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** Q5-08b (I-50): was heute im Haus los ist – Raumbuchungen (Aula, Sporthalle …), Wartungstermine, Raumsperren. */
async function HeuteImHaus({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const now = new Date();
  const data = await todayInHouse(db, current.perms, now);
  const empty = !data.bookings.length && !data.maintenance.length && !data.blocks.length && !data.events.length;
  return (
    <Card aria-label="Heute im Haus">
      <CardHeader title="Heute im Haus" action={data.bookingsVisible ? { href: "/buchungen", label: "Buchungen" } : undefined} />
      {empty ? (
        <p className="text-sm text-muted">Heute keine Veranstaltungen, Buchungen, Wartungen oder Sperrungen.</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {data.events.length > 0 && (
            <section aria-label="Veranstaltungen" className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Veranstaltungen</h3>
              <ul className="flex flex-col gap-0.5">
                {data.events.map((e) => {
                  const extra = setupText(e);
                  return (
                    <li key={e.id}>
                      <Link href={`/gebaeude/veranstaltungen/${e.id}`} className="hover:underline">
                        <span className="font-medium">{e.title}</span>
                        <span className="text-muted">
                          {" "}
                          · {e.span} · {eventPlace(e)}
                          {extra ? ` · ${extra}` : ""}
                          {e.status !== "bestaetigt" ? ` · ${EVENT_STATUS_LABELS[e.status]}` : ""}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {data.bookings.length > 0 && (
            <section aria-label="Raumbuchungen" className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Raumbuchungen</h3>
              <ul className="flex flex-col gap-0.5">
                {data.bookings.map((b) => (
                  <li key={b.id}>
                    <span className="font-medium">
                      {b.periodNr}. Std{b.startsAt ? ` (${b.startsAt})` : ""} · {b.resourceName}
                    </span>
                    <span className="text-muted"> · {[b.groupName, b.byName].filter(Boolean).join(", ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.maintenance.length > 0 && (
            <section aria-label="Wartung" className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Wartung</h3>
              <ul className="flex flex-col gap-0.5">
                {data.maintenance.map((m) => (
                  <li key={m.id}>
                    <Link href="/gebaeude/wartung" className="hover:underline">
                      <span className="font-medium">{m.title}</span>
                      <span className="text-muted">
                        {" "}
                        · {m.span}
                        {m.rooms.length ? ` · ${m.rooms.join(", ")}` : m.building ? ` · ${m.building}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.blocks.length > 0 && (
            <section aria-label="Raumsperren" className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Raumsperren</h3>
              <ul className="flex flex-col gap-0.5">
                {data.blocks.map((b) => (
                  <li key={b.id}>
                    <span className="font-medium">Raum {b.roomId}</span>
                    <span className="text-muted">
                      {" "}
                      · {blockLabel(b).replace(/^Gesperrt: /, "")}
                      {b.fromPeriod !== null && b.toPeriod !== null ? ` · ${b.fromPeriod}.–${b.toPeriod}. Std` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      <Link href="/gebaeude/veranstaltungen" className="flex min-h-6 items-center text-sm font-medium text-accent-ink hover:underline">
        Veranstaltungen: Wochenvorschau
      </Link>
    </Card>
  );
}

/** INV-05: eigene offene Leihgeräte (bzw. die der Kinder) – nur, wenn etwas ausgeliehen ist; ohne eigenes Recht. */
async function MeineLeihgeraete({ current }: { current: CurrentUser }) {
  const today = toBerlinDate(new Date());
  const data = await myLoans(await getDb(), current.perms, today);
  const open = [...data.own, ...data.children.flatMap((c) => c.loans.map((l) => ({ ...l, assetName: `${l.assetName} (${c.name})` })))].filter((l) => !l.returnedAt);
  if (!open.length) return null;
  return (
    <Card aria-label="Meine Leihgeräte">
      <CardHeader title="Meine Leihgeräte" action={{ href: "/gebaeude/leihen/meine", label: "Alle ansehen" }} />
      <ul className="flex flex-col gap-1 text-sm">
        {open.slice(0, 5).map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 px-2 py-1.5">
            <span className="min-w-0 truncate font-medium">{l.assetName}</span>
            <Badge tone={l.state === "ueberfaellig" ? "danger" : "soft"}>
              {l.state === "ueberfaellig" ? "überfällig" : "bis"} {formatLoanDay(l.dueOn)}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const gebaeudeWidgets: WidgetDef[] = [
  { id: "gebaeude.heute", moduleId: "gebaeude", order: 11, requires: "gebaeude.manage", Component: HeuteImHaus },
  { id: "gebaeude.offen", moduleId: "gebaeude", order: 12, requires: "gebaeude.manage", Component: Offen },
  { id: "gebaeude.meine", moduleId: "gebaeude", order: 60, requires: "gebaeude.report", Component: MeineMeldungen },
  { id: "gebaeude.leihen", moduleId: "gebaeude", order: 66, Component: MeineLeihgeraete },
];
