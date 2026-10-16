import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TIME_PREF_KINDS, type TimePrefKind } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { closePrefWindowAction, savePrefsAction, setPrefWindowAction } from "@/modules/stundenplan/actions";
import { REMIND_DAYS_BEFORE, formatDay, readPrefWindow, submissions, windowState } from "@/modules/stundenplan/zeitwunsch-fenster";
import { addDays, toBerlinDate } from "@/core/time";
import { Card, CardHeader } from "@schulos/ui/card";
import { plannableGroups, teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { allPrefs, prefsOf, TIME_PREF_LABELS } from "@/modules/stundenplan/zeitwuensche";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { PrefGrid } from "./pref-grid";
import { WindowForm } from "./window-form";

const WINDOW_TEXT = { none: "Kein Eingabefenster – Lehrkräfte sehen ihre Zeitwünsche nur.", planned: "Geplant", open: "Offen", closed: "Abgelaufen" } as const;

export const metadata: Metadata = { title: "Zeitwünsche" };

/** Zeitwünsche je Lehrkraft, Klasse/Kurs, Raum, Fach: −3 … +3 oder gesperrt je Stunde. */
export default async function ZeitwuenschePage({ searchParams }: { searchParams: Promise<{ art?: string; id?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const kind = (TIME_PREF_KINDS as readonly string[]).includes(sp.art ?? "") ? (sp.art as TimePrefKind) : "teacher";
  const today = toBerlinDate(new Date());
  const [teachers, groupList, master, prefs, window, submitted] = await Promise.all([
    teacherOptions(db),
    plannableGroups(db),
    timetableMasterData(db),
    allPrefs(db),
    readPrefWindow(db),
    submissions(db),
  ]);
  const wState = windowState(window, today);
  const missing = teachers.filter((t) => !submitted.has(t.id));
  const targets: Record<TimePrefKind, { id: string; label: string }[]> = {
    teacher: teachers.map((t) => ({ id: t.id, label: `${t.code} – ${t.name}` })),
    group: groupList.map((g) => ({ id: g.id, label: g.name })),
    room: master.rooms.map((r) => ({ id: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` })),
    subject: master.subjects.map((s) => ({ id: s.id, label: s.name })),
  };
  const target = targets[kind].find((t) => t.id === sp.id);
  const grid = target ? await prefsOf(db, kind, target.id) : new Map();
  const initial = Object.fromEntries([...grid].map(([k, v]) => [k, v === null ? "x" : String(v)]));
  // Übersicht: wer hat schon Wünsche?
  const withPrefs = targets[kind]
    .map((t) => ({ ...t, grid: prefs.get(`${kind}:${t.id}`) }))
    .filter((t) => t.grid && t.grid.size > 0)
    .map((t) => ({ ...t, blocked: [...t.grid!.values()].filter((v) => v === null).length, count: t.grid!.size, own: kind === "teacher" && submitted.has(t.id) }));

  return (
    <main className="flex flex-col gap-6">
      <Link href="/verwaltung/unterricht" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Unterrichtsverteilung
      </Link>
      <PageHeader eyebrow="Verwaltung" title="Zeitwünsche" />
      <p className="-mt-3 text-sm text-muted">
        −3 = sehr ungünstig … +3 = sehr erwünscht. „Gesperrt“ ist eine harte Regel: Setzhilfe und automatische Planung legen dort keine Stunde hin.
      </p>
      <Card aria-label="Eingabefenster für Lehrkräfte" className="gap-3">
        <CardHeader title="Eingabefenster für Lehrkräfte" />
        <p className="-mt-2 text-sm text-muted">
          Solange das Fenster offen ist, tragen Lehrkräfte ihre Zeitwünsche unter Stundenplan → Zeitwünsche selbst ein (nur die eigenen). Du siehst
          den Stand und kannst jederzeit überschreiben. Beim Öffnen bekommen alle Lehrkräfte einen Gong, {REMIND_DAYS_BEFORE} Tage vor dem letzten Tag eine
          Erinnerung, wer noch nicht abgegeben hat.
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={wState === "open" ? "success" : wState === "planned" ? "soft" : "neutral"}>{WINDOW_TEXT[wState]}</Badge>
          {window && (
            <span>
              {formatDay(window.opensOn)} – {formatDay(window.closesOn)}
            </span>
          )}
          {window && (
            <span className="text-muted">
              · {submitted.size} von {teachers.length} Lehrkräften haben abgegeben
            </span>
          )}
        </p>
        <WindowForm action={setPrefWindowAction} opensOn={window?.opensOn ?? today} closesOn={window?.closesOn ?? addDays(today, 14)} />
        {window && (
          <form action={closePrefWindowAction}>
            <Button type="submit" size="sm" variant="ghost">
              Fenster schließen
            </Button>
          </form>
        )}
        {window && missing.length > 0 && missing.length < teachers.length && (
          <p className="text-sm">
            <span className="text-muted">Noch nicht abgegeben: </span>
            {missing.map((t) => t.code).join(", ")}
          </p>
        )}
      </Card>
      <nav aria-label="Art" className="flex flex-wrap gap-2">
        {TIME_PREF_KINDS.map((k) => (
          <Button key={k} asChild size="sm" variant={k === kind ? "secondary" : "ghost"}>
            <Link href={`/verwaltung/unterricht/zeitwuensche?art=${k}`} aria-current={k === kind ? "page" : undefined}>
              {TIME_PREF_LABELS[k]}
            </Link>
          </Button>
        ))}
      </nav>
      <form className="flex flex-wrap items-end gap-3" aria-label="Auswahl">
        <input type="hidden" name="art" value={kind} />
        <Select name="id" defaultValue={target?.id ?? ""} aria-label={TIME_PREF_LABELS[kind]} className="w-72">
          <option value="">{TIME_PREF_LABELS[kind]} wählen</option>
          {targets[kind].map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
        <Button type="submit">Anzeigen</Button>
      </form>
      {target ? (
        <section aria-labelledby="grid-title" className="flex flex-col gap-3">
          <h2 id="grid-title" className="font-display text-xl font-bold">
            {target.label}
          </h2>
          <PrefGrid
            action={savePrefsAction.bind(null, kind, target.id)}
            weekdays={[...WEEKDAYS]}
            periods={master.periods.map((p) => ({ nr: p.nr, label: `${p.nr}. (${p.startsAt})` }))}
            initial={initial}
            title={target.label}
          />
        </section>
      ) : (
        <EmptyState title={`${TIME_PREF_LABELS[kind]} wählen`}>Oben auswählen, um die Zeitwünsche zu bearbeiten.</EmptyState>
      )}
      {withPrefs.length > 0 && (
        <section aria-labelledby="with-title" className="flex flex-col gap-2">
          <h2 id="with-title" className="font-semibold">
            Mit Zeitwünschen
          </h2>
          <ul className="flex flex-wrap gap-2">
            {withPrefs.map((t) => (
              <li key={t.id}>
                <Link href={`/verwaltung/unterricht/zeitwuensche?art=${kind}&id=${encodeURIComponent(t.id)}`} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm hover:border-border-strong">
                  {t.label}
                  {t.own && <Badge tone="soft">selbst abgegeben</Badge>}
                  {t.blocked > 0 && <Badge tone="danger">{t.blocked} gesperrt</Badge>}
                  <Badge>{t.count} Felder</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
