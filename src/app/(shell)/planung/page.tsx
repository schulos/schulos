import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { PLAN_MANAGE, PLAN_SUBSTITUTE, PLANNING_GROUP } from "@/modules/stundenplan/rechte";
import { planningOverview, type SubstituteFigures, type YearPlanningFigures } from "@/modules/stundenplan/uebersicht";
import { Badge } from "@schulos/ui/badge";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Stundenplanung" };

type Tone = "neutral" | "warn" | "danger" | "success" | "soft";

interface Tile {
  key: string;
  title: string;
  value: string;
  /** Kurztext neben der Zahl, z. B. „offen“ */
  status?: { label: string; tone: Tone };
  detail: string;
  href?: string;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const day = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));
const plural = (n: number, one: string, many: string) => `${num.format(n)} ${n === 1 ? one : many}`;

function yearTiles(m: YearPlanningFigures): Tile[] {
  const a = m.assignments;
  const tiles: Tile[] = [
    a.total === 0
      ? { key: "auftraege", title: "Offene Lehraufträge", value: "–", detail: "Noch keine Lehraufträge erfasst – hier anlegen oder aus dem Stundenplan übernehmen.", href: "/planung/unterricht" }
      : {
          key: "auftraege",
          title: "Offene Lehraufträge",
          value: num.format(a.open),
          status: a.open > 0 ? { label: "offen", tone: "warn" } : { label: "alle verplant", tone: "success" },
          detail: [
            `${plural(a.openHours, "Wochenstunde", "Wochenstunden")} offen von ${plural(a.total, "Lehrauftrag", "Lehraufträgen")}`,
            a.over > 0 ? `${a.over} zu viel verplant` : null,
            a.unmatched > 0 ? `${plural(a.unmatched, "Stunde", "Stunden")} ohne Lehrauftrag` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          href: "/planung/unterricht",
        },
    {
      key: "diagnose",
      title: "Diagnose: Fehler",
      value: num.format(m.diagnosis.error),
      status: m.diagnosis.error > 0 ? { label: "Fehler", tone: "danger" } : m.diagnosis.warn > 0 ? { label: m.diagnosis.warn === 1 ? "1 Warnung" : `${m.diagnosis.warn} Warnungen`, tone: "warn" } : { label: "ohne Befund", tone: "success" },
      detail: `${plural(m.diagnosis.error, "Fehler", "Fehler")} · ${plural(m.diagnosis.warn, "Warnung", "Warnungen")} (Stand ${date(m.refYmd)})`,
      href: "/planung/unterricht?ansicht=diagnose",
    },
  ];
  const w = m.prefWindow;
  const handedIn = `${w.submitted} von ${w.teachers} Lehrkräften abgegeben`;
  tiles.push(
    w.state === "open"
      ? { key: "zeitwuensche", title: "Zeitwünsche", value: `${w.submitted}/${w.teachers}`, status: { label: "Fenster offen", tone: "soft" }, detail: `${handedIn} · bis ${date(w.closesOn!)}`, href: "/planung/zeitwuensche" }
      : w.state === "planned"
        ? { key: "zeitwuensche", title: "Zeitwünsche", value: "–", status: { label: "geplant", tone: "neutral" }, detail: `Eingabefenster öffnet am ${date(w.opensOn!)}, bis ${date(w.closesOn!)}`, href: "/planung/zeitwuensche" }
        : w.state === "closed"
          ? { key: "zeitwuensche", title: "Zeitwünsche", value: `${w.submitted}/${w.teachers}`, status: { label: "geschlossen", tone: "neutral" }, detail: `${handedIn} · Fenster bis ${date(w.closesOn!)}`, href: "/planung/zeitwuensche" }
          : { key: "zeitwuensche", title: "Zeitwünsche", value: "–", detail: "Kein Eingabefenster für Lehrkräfte – Wünsche pflegt die Planung selbst oder öffnet ein Fenster.", href: "/planung/zeitwuensche" },
  );
  const r = m.lastRun;
  tiles.push(
    !r
      ? { key: "solver", title: "Automatisch planen", value: "–", detail: "Noch kein Lauf – Planvorschlag berechnen und ab Stichtag übernehmen.", href: "/planung/solver" }
      : r.status === "running"
        ? { key: "solver", title: "Letzter Solver-Lauf", value: `${r.progress} %`, status: { label: "rechnet", tone: "warn" }, detail: `gestartet ${dateTimeFmt.format(r.createdAt)} Uhr`, href: `/planung/solver?lauf=${r.id}` }
        : r.status === "failed"
          ? { key: "solver", title: "Letzter Solver-Lauf", value: "–", status: { label: "Fehler", tone: "danger" }, detail: `gestartet ${dateTimeFmt.format(r.createdAt)} Uhr`, href: `/planung/solver?lauf=${r.id}` }
          : {
              key: "solver",
              title: "Letzter Solver-Lauf",
              value: r.score === null ? "–" : num.format(r.score),
              status: r.status === "applied" ? { label: "übernommen", tone: "soft" } : { label: "fertig", tone: "success" },
              detail: [
                "Bewertung (kleiner ist besser)",
                r.unplaced ? `${plural(r.unplaced, "Einheit", "Einheiten")} nicht gesetzt` : null,
                r.status === "applied" && r.appliedFrom ? `gilt ab ${date(r.appliedFrom)}` : `vom ${dateTimeFmt.format(r.finishedAt ?? r.createdAt)} Uhr`,
              ]
                .filter(Boolean)
                .join(" · "),
              href: `/planung/solver?lauf=${r.id}`,
            },
  );
  return tiles;
}

function substituteTiles(s: SubstituteFigures): Tile[] {
  const open = s.days.reduce((n, d) => n + d.open, 0);
  const firstOpen = s.days.find((d) => d.open > 0)?.date ?? s.days[0]!.date;
  return [
    {
      key: "bedarf",
      title: "Vertretungsbedarf",
      value: num.format(open),
      status: open > 0 ? { label: "offen", tone: "danger" } : { label: "alles geregelt", tone: "success" },
      detail: s.days.map((d) => (d.total ? `${day(d.date)}: ${d.open} offen von ${d.total}` : `${day(d.date)}: kein Bedarf`)).join(" · "),
      href: `/planung/vertretungen?datum=${firstOpen}`,
    },
    {
      key: "entwuerfe",
      title: "Unveröffentlichte Entwürfe",
      value: num.format(s.drafts.length),
      status: s.drafts.length ? { label: "nicht veröffentlicht", tone: "warn" } : undefined,
      detail: s.drafts.length ? s.drafts.slice(0, 4).map(day).join(" · ") + (s.drafts.length > 4 ? " …" : "") : "Kein Vertretungsplan wartet auf Freigabe.",
      href: `/planung/vertretungen?datum=${s.drafts[0] ?? s.days[0]!.date}`,
    },
    {
      key: "aufsichten",
      title: "Unbesetzte Aufsichten",
      value: num.format(s.duties.open),
      status: s.duties.open ? { label: "offen", tone: "danger" } : undefined,
      detail: s.duties.total ? `${day(s.duties.date)}: ${s.duties.open} von ${plural(s.duties.total, "Aufsicht", "Aufsichten")} unbesetzt` : `${day(s.duties.date)}: keine Aufsichten geplant`,
      href: `/planung/aufsichten?datum=${s.duties.date}`,
    },
    {
      key: "raumsperren",
      title: "Raumsperren heute",
      value: num.format(s.roomBlocks.count),
      status: s.roomBlocks.count ? { label: "gesperrt", tone: "neutral" } : undefined,
      detail: s.roomBlocks.count ? s.roomBlocks.rooms.slice(0, 6).join(", ") + (s.roomBlocks.rooms.length > 6 ? " …" : "") : "Alle Räume frei nutzbar.",
      href: "/stundenplan/raeume?ansicht=sperrungen",
    },
  ];
}

function TileView({ t }: { t: Tile }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-sm text-muted">
        {t.title}
        {t.href && <ChevronRight aria-hidden className="size-4 shrink-0" />}
      </span>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-display text-3xl font-bold tracking-tight">{t.value}</span>
        {t.status && <Badge tone={t.status.tone}>{t.status.label}</Badge>}
      </span>
      <span className="text-sm text-muted">{t.detail}</span>
    </>
  );
  const cls = "flex h-full min-w-0 flex-col gap-1.5 rounded-card border border-border bg-surface p-4";
  return (
    <li data-kachel={t.key}>
      {t.href ? (
        <Link href={t.href} className={`${cls} transition hover:border-border-strong`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

function TileSection({ id, title, tiles }: { id: string; title: string; tiles: Tile[] }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <TileView key={t.key} t={t} />
        ))}
      </ul>
    </section>
  );
}

/**
 * SP-04 (docs/STUNDENPLAN-UMBAU.md §2.3): Übersicht des Bereichs – Kennzahlen aus vorhandenen Services, je Kachel ein Link auf den
 * Reiter. Jahresplanung nur mit `stundenplan.manage`, Tagesgeschäft nur mit `stundenplan.substitute`.
 */
export default async function PlanungPage() {
  const { perms } = await requireUser();
  const manage = hasPermission(perms, PLAN_MANAGE);
  const substitute = hasPermission(perms, PLAN_SUBSTITUTE);
  const schoolData = hasPermission(perms, "verwaltung.school");
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const o = await planningOverview(db, today, { manage, substitute });
  const yearLine = o.year
    ? `Schuljahr ${o.year.name} · ${date(o.year.startsOn)} – ${date(o.year.endsOn)}${o.year.isCurrent ? "" : " (nicht als aktuell markiert)"}`
    : null;
  return (
    <main className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <PageHeader eyebrow="Organisation" title="Stundenplanung" />
        <p className="flex flex-col gap-0.5 text-sm text-muted" data-testid="planungsjahr">
          <span>{yearLine ?? "Noch kein Schuljahr angelegt."}</span>
          {schoolData ? (
            <Link href="/verwaltung/stammdaten" className="font-medium text-accent-ink hover:underline">
              Stammdaten: Fächer, Räume, Zeitraster, Schuljahre
            </Link>
          ) : (
            <span>Stammdaten wie Fächer, Räume und Zeitraster pflegt die Verwaltung.</span>
          )}
        </p>
      </div>
      {manage &&
        (o.manage ? (
          <TileSection id="jahresplanung" title="Jahresplanung" tiles={yearTiles(o.manage)} />
        ) : (
          <section aria-labelledby="jahresplanung" className="flex flex-col gap-3">
            <h2 id="jahresplanung" className="text-base font-semibold">
              Jahresplanung
            </h2>
            <p className="rounded-card border border-dashed border-border-strong px-4 py-6 text-sm text-muted">
              Ohne Schuljahr gibt es nichts zu planen – {schoolData ? "lege es unter Stammdaten → Schuljahre an." : "die Verwaltung legt es unter Stammdaten an."}
            </p>
          </section>
        ))}
      {o.substitute && <TileSection id="tagesgeschaeft" title="Tagesgeschäft" tiles={substituteTiles(o.substitute)} />}
      <p className="text-sm">
        <Link href="/stundenplan/raeume" className="font-medium text-accent-ink hover:underline">
          Räume: Belegung, freie Räume und Raumsperren
        </Link>
      </p>
      <p role="note" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
        Wer plant, gehört zur Gruppe „{PLANNING_GROUP.name}“ (beide Planungsrechte). Mitglieder trägt nur ein, wer beide Rechte selbst
        hat – auf einer neuen Installation die Administration unter Verwaltung → Gruppen. Nur „Vertretungen planen“ (z. B. fürs
        Sekretariat) kann unter Verwaltung → Rechte & Module auch einer Rolle gegeben werden.
      </p>
    </main>
  );
}
