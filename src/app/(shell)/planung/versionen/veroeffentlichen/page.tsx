import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Send } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, isCalendarDate, toBerlinDate } from "@/core/time";
import { publishVersionAction } from "@/modules/stundenplan/actions";
import { publishedTimeline } from "@/modules/stundenplan/plan-archiv";
import { gateProblem, publishGate } from "@/modules/stundenplan/fahrplan";
import { getVersion, STATUS_LABELS, versionNumber } from "@/modules/stundenplan/planversionen";
import { PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import { isPublishUndoable, publishPreview, undoPublishPreview, type PublishPreview, type UndoPublishPreview } from "@/modules/stundenplan/veroeffentlichen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Input } from "@schulos/ui/field";
import { PageHeader } from "@schulos/ui/misc";
import { UndoPublish } from "./undo-publish";

export const metadata: Metadata = { title: "Planversion veröffentlichen" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));
/** Zahl mit Einzahl/Mehrzahl. */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function PreviewList({ p }: { p: PublishPreview }) {
  const c = p.counts;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Stunden">
        {(
          [
            ["unverändert", c.unchanged, "behalten ihre Zeile (Klassenbuch, Vertretungen, Material bleiben)"],
            ["geändert", c.changed, "alte Zeile endet am Vortag, neue ab Stichtag"],
            ["neu", c.added, "gelten ab Stichtag"],
            ["entfallen", c.removed, "enden am Vortag"],
          ] as const
        ).map(([label, value, hint]) => (
          <div key={label} className="rounded-card border border-border bg-surface px-3 py-2">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-display text-xl font-bold tabular-nums" data-testid={`zahl-${label}`}>
              {value}
            </dd>
            <dd className="text-xs text-muted">{hint}</dd>
          </div>
        ))}
      </dl>
      <ul className="list-disc pl-5 text-sm" aria-label="Was beim Veröffentlichen passiert">
        {(p.changedTiming > 0 || p.changedWithCoupling > 0) && (
          <li>
            Davon geändert {p.changedTiming > 0 ? n(p.changedTiming, "Stunde nur im Zeitraum", "Stunden nur im Zeitraum") : ""}
            {p.changedTiming > 0 && p.changedWithCoupling > 0 ? " und " : ""}
            {p.changedWithCoupling > 0 ? n(p.changedWithCoupling, "Stunde, weil ein Teil ihrer Kopplung sich ändert", "Stunden, weil ein Teil ihrer Kopplung sich ändert") : ""}.
          </li>
        )}
        {p.deleted > 0 && <li>{n(p.deleted, "Stunde begann erst ab dem Stichtag und wird gelöscht", "Stunden begannen erst ab dem Stichtag und werden gelöscht")} (das Zurücknehmen legt sie wieder an).</li>}
        <li data-testid="vertretungen">
          Vertretungen ab dem Stichtag: {n(p.substitutions.moved, "zieht um", "ziehen um")}
          {p.substitutions.removed > 0 ? `, ${n(p.substitutions.removed, "entfällt", "entfallen")} (Stunde findet an dem Tag nicht mehr statt – gesichert, das Zurücknehmen stellt sie wieder her)` : ""}.
        </li>
        <li data-testid="material">
          Material: {n(p.materials.moved, "zieht um", "ziehen um")}
          {p.materials.removed > 0 ? `, ${n(p.materials.removed, "entfällt", "entfallen")} (gesichert)` : ""} · Klassenbuch ab dem Stichtag: {n(p.classbook.moved, "Eintrag zieht um", "Einträge ziehen um")}
          {p.classbook.detached > 0 ? `, ${n(p.classbook.detached, "verliert", "verlieren")} den Bezug zur Stunde` : ""}. Einträge vor dem Stichtag bleiben, wo sie sind.
        </li>
        {(p.roomClashes.bookings > 0 || p.roomClashes.exams > 0) && (
          <li>
            Neue Stunden belegen Räume, in denen{" "}
            {[p.roomClashes.bookings ? n(p.roomClashes.bookings, "Raumbuchung", "Raumbuchungen") : null, p.roomClashes.exams ? n(p.roomClashes.exams, "Klausur", "Klausuren") : null].filter(Boolean).join(" und ")}{" "}
            ab dem Stichtag liegen – Räume prüfen.
          </li>
        )}
        <li>
          {p.previous ? `Version ${p.previous.label} „${p.previous.name}“ gilt bis zum Vortag und wird archiviert.` : "Bisher gibt es keine gültige Version in diesem Schuljahr."}
          {p.variants.length > 0 && ` ${p.variants.length === 1 ? "Die Variante" : "Die Varianten"} ${p.variants.map((x) => `„${x.name}“`).join(", ")} derselben Nummer ${p.variants.length === 1 ? "wird" : "werden"} verworfen (veröffentlicht wird genau eine).`}
          {p.otherDrafts > 0 && ` ${n(p.otherDrafts, "anderer offener Entwurf bleibt", "andere offene Entwürfe bleiben")} stehen – er bezieht sich noch auf den bisherigen Plan.`}
        </li>
        <li data-testid="gong">
          Änderungsliste: {n(p.teachers, "Lehrkraft bekommt", "Lehrkräfte bekommen")} sie sofort, Schüler:innen und Eltern aus {n(p.groups, "Klasse/Kurs", "Klassen/Kursen")} am Vortag zur
          eingestellten Uhrzeit ({n(p.changes, "Änderung", "Änderungen")} insgesamt; ohne Kommentare und Entwürfe).
        </li>
      </ul>
    </div>
  );
}

function UndoList({ u }: { u: UndoPublishPreview }) {
  const items = [
    u.changed > 0 ? `${n(u.changed, "neue Stunde wurde", "neue Stunden wurden")} seit dem Veröffentlichen von Hand verändert – sie werden trotzdem entfernt.` : null,
    `${n(u.substitutionsBack, "Vertretung zieht", "Vertretungen ziehen")}, ${n(u.materialsBack, "Material zieht", "Materialien ziehen")} und ${n(u.classbookBack, "Klassenbuch-Eintrag zieht", "Klassenbuch-Einträge ziehen")} zurück an die bisherige Stunde.`,
    u.substitutionsLost + u.materialsLost + u.classbookLost > 0
      ? `An neuen Stunden ohne bisherige Stunde: ${n(u.substitutionsLost, "Vertretung geht", "Vertretungen gehen")} verloren, ${n(u.materialsLost, "Material geht", "Materialien gehen")} verloren, ${n(u.classbookLost, "Klassenbuch-Eintrag verliert", "Klassenbuch-Einträge verlieren")} den Bezug.`
      : null,
    `${n(u.restoredSubstitutions, "beim Veröffentlichen entfernte Vertretung kommt", "beim Veröffentlichen entfernte Vertretungen kommen")} zurück${u.lostSubstitutions ? ` (${u.lostSubstitutions} nicht – ihre Stunde gilt an dem Tag nicht mehr)` : ""}; ${n(u.restoredMaterials, "Material kommt", "Materialien kommen")} zurück; ${n(u.reattachedClassbook, "Klassenbuch-Eintrag bekommt", "Klassenbuch-Einträge bekommen")} den Bezug zurück.`,
    u.notRestorable > 0 ? `${n(u.notRestorable, "beendete Stunde lässt", "beendete Stunden lassen")} sich nicht wiederherstellen (inzwischen gelöscht oder verändert).` : null,
    u.reinsert > 0 || u.reinsertSkipped > 0 ? `${n(u.reinsert, "gelöschte Stunde wird", "gelöschte Stunden werden")} wieder angelegt${u.reinsertSkipped ? `, ${u.reinsertSkipped} nicht (Gruppe oder Fach gelöscht)` : ""}.` : null,
    u.foreign > 0 ? `${n(u.foreign, "Stunde, die nach dem Veröffentlichen von Hand angelegt wurde, bleibt", "Stunden, die nach dem Veröffentlichen von Hand angelegt wurden, bleiben")} – danach die Diagnose prüfen.` : null,
    u.roomClashes.bookings > 0 || u.roomClashes.exams > 0
      ? `Der bisherige Plan belegt ab dem Stichtag Räume, in denen ${[u.roomClashes.bookings ? n(u.roomClashes.bookings, "Raumbuchung", "Raumbuchungen") : null, u.roomClashes.exams ? n(u.roomClashes.exams, "Klausur", "Klausuren") : null].filter(Boolean).join(" und ")} liegen.`
      : null,
  ].filter(Boolean);
  return (
    <ul className="list-disc pl-5 text-sm text-muted" aria-label="Was beim Zurücknehmen zu beachten ist">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

const OK_TEXT: Record<string, string> = {
  veroeffentlicht: "Veröffentlicht. Bis zum Stichtag lässt sich die Veröffentlichung zurücknehmen.",
  zurueckgenommen: "Veröffentlichung zurückgenommen – der bisherige Plan gilt wieder, die Version ist wieder freigegeben.",
};

/**
 * SP3-04 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.3, §4 Schritt 8): eine freigegebene Version ab einem Stichtag veröffentlichen – Vorschau mit
 * Zahlen vor dem Klick (unverändert/geändert/neu/entfallen, Vertretungen, Material, Klassenbuch, Räume, Varianten, Gong) – und eine
 * veröffentlichte Version bis zum Stichtag zurücknehmen (Vorschau mit Konfliktzählung). Nur `stundenplan.manage`. SP3-06: veröffentlichen erst,
 * wenn Schritt 7 des Fahrplans erfüllt ist (Diagnose ohne Fehler, jede Warnung quittiert) – sonst Hinweis mit Sprung in den Fahrplan.
 */
export default async function VeroeffentlichenPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string; ab?: string; ok?: string; fehler?: string; lehrkraefte?: string; vertretungen?: string; material?: string }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, PLAN_MANAGE)) notFound();
  const sp = await searchParams;
  if (!sp.version) notFound();
  const db = await getDb();
  const v = await getVersion(db, sp.version);
  if (!v) notFound();
  const today = toBerlinDate(new Date());
  const label = versionNumber(v);
  const cal = await loadSchoolCalendar(db);
  // Vorgabe: vorgemerkter Stichtag, wenn er noch kommt, sonst der nächste Schultag
  const fallback = v.validFrom && v.validFrom > today ? v.validFrom : cal.nextSchoolDay(addDays(today, 1));
  const from = sp.ab && isCalendarDate(sp.ab) ? sp.ab : fallback;
  const [preview, undo, timeline] = await Promise.all([
    v.status === "freigegeben" ? publishPreview(db, v.id, from, today) : Promise.resolve(null),
    isPublishUndoable(v, today) ? undoPublishPreview(db, v.id, today) : Promise.resolve(null),
    publishedTimeline(db, v.schoolYearId),
  ]);
  // SP3-06: Schritt 7 des Fahrplans (Diagnose ohne Fehler, Warnungen quittiert) ist Bedingung fürs Veröffentlichen
  const gate = preview?.ok ? await publishGate(db, v, today) : null;
  const blocked = gate ? gateProblem(gate) : null;
  const self = `/planung/versionen/veroeffentlichen`;
  return (
    <main className="flex flex-col gap-6">
      <Link href={`/planung/versionen?jahr=${encodeURIComponent(v.schoolYearId)}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Planversionen
      </Link>
      <PageHeader eyebrow="Stundenplanung · Planversionen" title={`Veröffentlichen · Version ${label}`} />
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.ok && OK_TEXT[sp.ok] && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {OK_TEXT[sp.ok]}
          {sp.ok === "veroeffentlicht" && sp.lehrkraefte ? ` ${n(Number(sp.lehrkraefte), "Lehrkraft hat", "Lehrkräfte haben")} die Änderungsliste bekommen.` : ""}
          {sp.ok === "zurueckgenommen" && (sp.vertretungen || sp.material)
            ? ` ${n(Number(sp.vertretungen ?? 0), "Vertretung", "Vertretungen")} und ${n(Number(sp.material ?? 0), "Material", "Materialien")} wieder an der bisherigen Stunde.`
            : ""}
        </p>
      )}

      <Card aria-labelledby="version-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="version-title" className="min-w-0 font-semibold break-words">
            <span className="font-display text-lg">Version {label}</span> <span className="block text-sm font-normal text-muted">{v.name}</span>
          </h2>
          <Badge tone={v.status === "gueltig" ? "success" : v.status === "freigegeben" ? "soft" : "neutral"}>{STATUS_LABELS[v.status]}</Badge>
        </div>
        <p className="text-sm text-muted">
          {v.status === "gueltig" && v.validFrom
            ? `Gültig ab ${date(v.validFrom)}${v.publishedAt ? ` · veröffentlicht ${dateTimeFmt.format(v.publishedAt)}` : ""}.`
            : v.status === "archiviert" && v.validFrom
              ? `Galt ${date(v.validFrom)} – ${v.validUntil ? date(v.validUntil) : "…"}.`
              : v.status === "freigegeben"
                ? `Freigegeben${v.validFrom ? `, vorgemerkt ab ${date(v.validFrom)}` : ""}. Veröffentlichen ersetzt den gültigen Plan ab dem Stichtag; bis dahin gilt der bisherige Plan.`
                : "Nur freigegebene Versionen lassen sich veröffentlichen – erst zur Prüfung geben und freigeben lassen."}
        </p>
        <nav aria-label={`Version ${label}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/planung/versionen/aenderungen?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
            Änderungen zum gültigen Plan
          </Link>
          <Link href={`/planung/versionen/pruefung?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
            Prüfung & Kommentare
          </Link>
          <Link href={`/planung/fahrplan?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
            Planungsfahrplan
          </Link>
        </nav>
      </Card>

      {preview && (
        <Card aria-labelledby="publish-title" className="flex flex-col gap-4">
          <h2 id="publish-title" className="text-base font-semibold">
            Vorschau der Veröffentlichung
          </h2>
          <form action={self} method="get" aria-label="Stichtag wählen" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="version" value={v.id} />
            <Field label="Gültig ab (Schultag)" className="w-56">
              <Input type="date" name="ab" defaultValue={from} required />
            </Field>
            <Button type="submit" variant="secondary">
              Vorschau aktualisieren
            </Button>
          </form>
          {preview.ok ? (
            <>
              <PreviewList p={preview.preview} />
              {blocked ? (
                <div role="alert" data-testid="fahrplan-sperre" className="flex flex-col gap-1 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                  <p>{blocked}.</p>
                  <Link href={`/planung/fahrplan?version=${encodeURIComponent(v.id)}#schritt-pruefen`} className="font-semibold underline">
                    Zum Fahrplan, Schritt 7 „Prüfen“
                  </Link>
                </div>
              ) : (
                <form action={publishVersionAction.bind(null, v.id)} aria-label="Veröffentlichen" className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                  <input type="hidden" name="from" value={from} />
                  <Button type="submit" variant="primary">
                    <Send aria-hidden /> Ab {date(from)} veröffentlichen
                  </Button>
                  <span className="text-sm text-muted">
                    Diagnose ohne Fehler{gate && gate.warnings.length ? `, ${n(gate.warnings.length, "Warnung", "Warnungen")} quittiert` : ""}. Bis zum Stichtag lässt sich die Veröffentlichung zurücknehmen.
                  </span>
                </form>
              )}
            </>
          ) : (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {preview.problem}
            </p>
          )}
        </Card>
      )}

      {undo && (
        <Card aria-labelledby="undo-title" className="flex flex-col gap-3">
          <h2 id="undo-title" className="text-base font-semibold">
            Veröffentlichung zurücknehmen
          </h2>
          <p className="text-sm text-muted">
            Bis zum Stichtag ({date(v.validFrom!)}) möglich: {n(undo.lessons, "neue Stunde wird", "neue Stunden werden")} entfernt, {n(undo.restorable, "beendete Stunde gilt", "beendete Stunden gelten")}{" "}
            wieder bis zu ihrem früheren Ende. Die Version ist danach wieder freigegeben, die Vorgängerin wieder gültig.
          </p>
          <UndoList u={undo} />
          <div>
            <UndoPublish id={v.id} label={label} lessons={undo.lessons} lost={undo.substitutionsLost + undo.materialsLost + undo.classbookLost + undo.lostSubstitutions} />
          </div>
        </Card>
      )}
      {v.status === "gueltig" && !undo && v.validFrom && (
        <p className="text-sm text-muted">Die Version gilt seit {date(v.validFrom)} – zurücknehmen geht nur bis zum Stichtag. Änderungen laufen über eine Folgeversion.</p>
      )}

      <section aria-labelledby="zeitstrahl-title" className="flex flex-col gap-2">
        <h2 id="zeitstrahl-title" className="font-display text-xl font-bold">
          Zeitstrahl
        </h2>
        <ol className="flex flex-col gap-1.5 text-sm" aria-label="Veröffentlichte Versionen">
          {timeline.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-2">
              <Badge tone={t.status === "gueltig" ? "success" : "neutral"}>{STATUS_LABELS[t.status]}</Badge>
              <span className="font-medium">Version {t.label}</span>
              <span className="text-muted">„{t.name}“</span>
              <span className="tabular-nums">
                {t.validFrom ? date(t.validFrom) : "…"} – {t.validUntil ? date(t.validUntil) : "offen"}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
