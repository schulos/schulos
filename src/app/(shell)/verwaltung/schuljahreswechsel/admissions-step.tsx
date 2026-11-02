"use client";

import { Download, Pin, Printer, Shuffle } from "lucide-react";
import { startTransition, useActionState, useMemo, useState } from "react";
import { explain, proposeClasses, type KbChild, type KbExplanation } from "@/modules/anmeldung/klassenbildung";
import type { AdmissionCredential } from "@/modules/anmeldung/uebernahme";
import { admissionsAction, regeneratePasswordsAction, type AdmissionsState, type RegeneratePasswordsState } from "@/modules/verwaltung/schuljahreswechsel-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

export interface AdmissionRow {
  antragId: string;
  number: string;
  /** neutraler Familienschlüssel (gleiche E-Mail von Elternteil 1) für die Klassenbildung – nie die Adresse selbst */
  family: string;
  child: string;
  birth: string;
  school: string;
  sibling: string | null;
  parent: string;
  /** vorhandenes Elternkonto (Name), sonst null = wird angelegt */
  existingParent: string | null;
  /** Q5-20: Elternkonto mit derselben, aber unbestätigten E-Mail – nur mit Haken verknüpft */
  suggestedParent: string | null;
  /**
   * Q5-23: zweiter Elternteil (nur mit E-Mail im Antrag). GATE-031 (S-01): die Adresse ist unbestätigt – ein Treffer ist immer
   * nur ein Vorschlag (`why` erklärt ihn), ohne Haken entsteht ein neues Konto ohne die Adresse.
   */
  parent2: { name: string; suggested: string | null; why: string | null } | null;
  gradeLevel: number;
}

/** Zelle „Elternkonto“: vorhanden, Vorschlag zum Ankreuzen (Q5-20) oder neu. */
function ParentCell({
  field,
  antragId,
  name,
  existing,
  suggested,
  why = "gleiche E-Mail, aber unbestätigt",
}: {
  field: "link" | "link2";
  antragId: string;
  name: string;
  existing: string | null;
  suggested: string | null;
  why?: string | null;
}) {
  if (existing) return <>vorhanden: {existing}</>;
  if (suggested)
    return (
      <label className="flex items-start gap-2">
        <input type="checkbox" name={`${field}:${antragId}`} value="1" defaultChecked={false} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Vorschlag: {suggested} verknüpfen
          <span className="block text-xs text-muted">
            {why} – ohne Haken: neu: {name}
          </span>
        </span>
      </label>
    );
  return <>neu: {name}</>;
}

const SKIP = "nicht";
const split = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

const toChild = (r: AdmissionRow): KbChild => ({ id: r.antragId, label: r.child, school: r.school || null, family: r.family });

/**
 * KB-02: Vorschlag je Jahrgang aus `klassenbildung.ts`. Festgepinnte Kinder bleiben stehen; wer festgepinnt „nicht übernehmen“
 * hat, nimmt nicht teil. Rechnet im Browser – der Entwurf wird nicht gespeichert (kb-8).
 */
function propose(
  levels: readonly { level: number }[],
  rows: readonly AdmissionRow[],
  options: Record<number, string[]>,
  assign: Record<string, string>,
  pinned: ReadonlySet<string>,
  seed: number,
): Record<string, string> {
  const out = { ...assign };
  for (const l of levels) {
    const classNames = options[l.level] ?? [];
    const mine = rows.filter((r) => r.gradeLevel === l.level && !(pinned.has(r.antragId) && assign[r.antragId] === SKIP));
    const pins = Object.fromEntries(mine.filter((r) => pinned.has(r.antragId) && classNames.includes(assign[r.antragId] ?? "")).map((r) => [r.antragId, assign[r.antragId]!]));
    const res = proposeClasses({ children: mine.map(toChild), classNames, pinned: pins, seed });
    for (const r of mine) out[r.antragId] = res.assignment[r.antragId] ?? "";
  }
  return out;
}

/**
 * Schritt „Neuaufnahmen“ (P4-39): je Jahrgang die neuen Klassen (Kurznamen), je Kind die Klasse (Vorschlag der Klassenbildung
 * KB-01/02 vorbelegt, mit Begründung je Kind, Kennzahlen je Klasse, „Neu vorschlagen“ und Festpinnen) oder „nicht übernehmen“.
 * Danach einmalig die Zugangsdaten als Liste, CSV und Druck – nicht per Mail.
 */
export function AdmissionsStep({
  transitionId,
  canCreate,
  levels,
  rows,
  sizeHint,
}: {
  transitionId: string;
  /** Recht „Benutzer verwalten“ (Konten anlegen); ohne geht nur „Niemanden übernehmen“ */
  canCreate: boolean;
  levels: { level: number; name: string; classes: string[] }[];
  rows: AdmissionRow[];
  /** Richtwert Klassengröße (Einstellung `anmeldung.klassengroesse`) – nur für die Anzeige */
  sizeHint: number;
}) {
  const [state, formAction, pending] = useActionState<AdmissionsState, FormData>(admissionsAction, {});
  const [classText, setClassText] = useState<Record<number, string>>(Object.fromEntries(levels.map((l) => [l.level, l.classes.join(", ")])));
  const options = useMemo(() => Object.fromEntries(levels.map((l) => [l.level, split(classText[l.level] ?? "")])), [levels, classText]);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [seed, setSeed] = useState(0);
  const [assign, setAssign] = useState<Record<string, string>>(() => propose(levels, rows, options, {}, new Set(), 0));
  const [skipAll, setSkipAll] = useState(false);
  const explained = useMemo(() => {
    const out: Record<number, KbExplanation> = {};
    const pins = Object.fromEntries([...pinned].map((id) => [id, assign[id] ?? ""]));
    for (const l of levels) out[l.level] = explain({ children: rows.filter((r) => r.gradeLevel === l.level).map(toChild), classNames: options[l.level] ?? [], pinned: pins }, assign);
    return out;
  }, [levels, rows, options, assign, pinned]);
  const togglePin = (id: string, on: boolean) =>
    setPinned((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const reshuffle = () => {
    const next = seed + 1;
    setSeed(next);
    setAssign(propose(levels, rows, options, assign, pinned, next));
  };

  if (state.ok && state.result) {
    const r = state.result;
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="font-semibold text-success">
          {r.students === 0 ? "Niemand übernommen – Schritt abgeschlossen" : `${r.students} Kinder in ${r.classes} Klassen übernommen`} · {r.parentsCreated} Elternkonten angelegt, {r.parentsLinked} vorhandene verknüpft
          {r.parentsSuggestedLinked > 0 && ` (davon ${r.parentsSuggestedLinked} per Vorschlag)`}
          {r.skipped > 0 && ` · ${r.skipped} nicht übernommen`}
        </p>
        <CredentialsView credentials={r.credentials} csv={state.csv ?? ""} />
      </div>
    );
  }

  return (
    <form
      aria-label="Neuaufnahmen"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => formAction(fd));
      }}
    >
      <input type="hidden" name="transitionId" value={transitionId} />
      <p className="text-sm text-muted">
        Aufgenommene Kinder aus der Schulanmeldung werden Schüler:innen im neuen Schuljahr: Klassen anlegen, Kinder zuordnen, Konten für Kind
        und Elternteil erzeugen – auch für den zweiten Elternteil, wenn im Antrag seine E-Mail-Adresse steht (vorhandene Elternkonten werden
        verknüpft; Konten mit gleicher, aber unbestätigter E-Mail nur, wenn der Vorschlag angekreuzt ist). Beim zweiten Elternteil ist die Adresse
        nie bestätigt: verknüpft wird dort nur mit Haken, sonst entsteht ein neues Konto ohne die Adresse. Die Zuordnung ist nur ein Vorschlag
        (Größen höchstens 1 Kind Unterschied, Familien zusammen, Grundschulen gemischt – kein Geschlecht, keine weiteren Merkmale) und wird
        nicht gespeichert, bis die Neuaufnahmen übernommen sind. Übernommen werden nur Name, Klasse und die E-Mail der Eltern; alles Weitere bleibt in der
        Schulverwaltungssoftware.
      </p>
      {levels.map((l) => (
        <Field key={l.level} label={`Neue Klassen ${l.name}`} hint="Kurznamen mit Komma, z. B. 5a, 5b, 5c – leere Klassen werden nicht angelegt" error={state.fieldErrors?.[`classes-${l.level}`]}>
          <Input name={`classes:${l.level}`} value={classText[l.level] ?? ""} onChange={(e) => setClassText((s) => ({ ...s, [l.level]: e.target.value }))} className="max-w-md" />
        </Field>
      ))}
      <section aria-label="Kennzahlen je Klasse" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={reshuffle}>
            <Shuffle aria-hidden /> Neu vorschlagen
          </Button>
          <span className="text-sm text-muted" aria-live="polite" data-testid="vorschlag-info">
            Vorschlag {seed + 1} · Richtwert {sizeHint} Kinder je Klasse · {pinned.size} festgepinnt (bleiben beim Neu vorschlagen stehen; eine
            von Hand gewählte Klasse wird automatisch festgepinnt)
          </span>
        </div>
        {levels.map((l) => {
          const ex = explained[l.level];
          if (!ex?.stats.length) return null;
          const withWishes = ex.stats.some((x) => x.wishesTotal > 0);
          return (
            <div key={l.level} className="flex flex-col gap-1">
              <Table>
                <caption className="sr-only">Kennzahlen {l.name}</caption>
                <thead>
                  <tr>
                    <th>Klasse</th>
                    <th className="text-right">Kinder</th>
                    <th className="text-right">festgepinnt</th>
                    <th>Grundschulen</th>
                    <th className="text-right">allein aus ihrer Grundschule</th>
                    {withWishes && <th className="text-right">Wünsche erfüllt</th>}
                  </tr>
                </thead>
                <tbody>
                  {ex.stats.map((x) => (
                    <tr key={x.name}>
                      <td className="font-medium">{x.name}</td>
                      <td className="text-right tabular-nums">{x.size}</td>
                      <td className="text-right tabular-nums">{x.pinned}</td>
                      <td className="text-sm">{x.schools.map((sc) => `${sc.school} ${sc.count}`).join(" · ") || "–"}</td>
                      <td className="text-right tabular-nums">{x.alone}</td>
                      {withWishes && (
                        <td className="text-right tabular-nums">
                          {x.wishesMet} / {x.wishesTotal}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
              {ex.warnings.length > 0 && (
                <ul className="text-sm text-danger" aria-label={`Hinweise ${l.name}`}>
                  {ex.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>
      <Table>
        <caption className="sr-only">Zuordnung</caption>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Grundschule</th>
            <th>Geschwister</th>
            <th>Elternkonto</th>
            <th>Klasse und Begründung</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.antragId}>
              <td>
                <span className="font-medium">{r.child}</span>
                <span className="block text-xs text-muted tabular-nums">
                  {r.number} · {r.birth}
                </span>
              </td>
              <td>{r.school || "–"}</td>
              <td className="text-sm">{r.sibling ?? "–"}</td>
              <td className="text-sm">
                <ParentCell field="link" antragId={r.antragId} name={r.parent} existing={r.existingParent} suggested={r.suggestedParent} />
                {r.parent2 && (
                  <div className="mt-1 border-t border-border pt-1" data-testid="elternteil2">
                    <span className="block text-xs text-muted">Zweiter Elternteil</span>
                    <ParentCell field="link2" antragId={r.antragId} name={r.parent2.name} existing={null} suggested={r.parent2.suggested} why={r.parent2.why} />
                  </div>
                )}
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <Select
                    name={`a:${r.antragId}`}
                    value={assign[r.antragId] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAssign((s) => ({ ...s, [r.antragId]: v }));
                      togglePin(r.antragId, v !== "");
                    }}
                    aria-label={`Klasse für ${r.child}`}
                    className="h-9 w-40 text-sm"
                  >
                    <option value="">– wählen –</option>
                    {(options[r.gradeLevel] ?? []).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    <option value={SKIP}>nicht übernehmen</option>
                  </Select>
                  <label className="flex min-h-6 items-center gap-1 text-xs text-muted" title="Festpinnen: bleibt beim Neu vorschlagen stehen">
                    <input
                      type="checkbox"
                      checked={pinned.has(r.antragId)}
                      onChange={(e) => togglePin(r.antragId, e.target.checked)}
                      aria-label={`Festpinnen: ${r.child}`}
                      className="size-6 accent-[var(--accent)]"
                    />
                    <Pin aria-hidden className="size-3.5" />
                  </label>
                </div>
                {(explained[r.gradeLevel]?.reasons[r.antragId]?.length ?? 0) > 0 && (
                  <ul className="mt-1 max-w-xs text-xs text-muted" aria-label={`Begründung für ${r.child}`} data-testid="begruendung">
                    {explained[r.gradeLevel]!.reasons[r.antragId]!.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                )}
                {state.fieldErrors?.[`assign-${r.antragId}`] && <span className="block text-xs text-danger">{state.fieldErrors[`assign-${r.antragId}`]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {!canCreate && (
        <p className="text-sm text-muted">
          Zum Anlegen der Konten braucht es das Recht „Benutzer verwalten“ – ohne dieses Recht ist nur „Niemanden übernehmen“ möglich.
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="skipAll" checked={skipAll} onChange={(e) => setSkipAll(e.target.checked)} className="mt-1" />
        <span>
          Niemanden übernehmen (z. B. alle Zusagen zurückgenommen) – Schritt ohne neue Konten abschließen. Die Anträge bleiben „aufgenommen“
          und werden mit dem Verfahren gelöscht.
        </span>
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending || (!canCreate && !skipAll)}>
          {pending ? "Bitte warten …" : skipAll ? "Schritt ohne Übernahme abschließen" : "Neuaufnahmen übernehmen"}
        </Button>
      </div>
    </form>
  );
}

/** Zugangsdaten einmalig: Hinweis, CSV, Druck, Tabelle (nach dem Übernehmen und nach „Startpasswörter neu erzeugen“). */
function CredentialsView({ credentials, csv }: { credentials: AdmissionCredential[]; csv: string }) {
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  return (
    <>
      <p className="text-sm text-muted">
        Die Startpasswörter werden nur jetzt angezeigt – Liste herunterladen oder drucken und am Einschulungstag auf Papier ausgeben (nicht
        per Mail). Eltern richten bei der ersten Anmeldung die Zwei-Faktor-Anmeldung ein.
      </p>
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="primary">
          <a href={url} download="zugangsdaten-neuaufnahmen.csv">
            <Download aria-hidden /> Zugangsdaten herunterladen (CSV)
          </a>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer aria-hidden /> Drucken
        </Button>
        <Button asChild variant="ghost">
          <a href="/verwaltung/schuljahreswechsel">Weiter zum nächsten Schritt</a>
        </Button>
      </div>
      <Table aria-label="Zugangsdaten">
        <thead>
          <tr>
            <th>Art</th>
            <th>Name</th>
            <th>Klasse</th>
            <th>Benutzername</th>
            <th>Startpasswort</th>
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((c) => (
            <tr key={`${c.art}-${c.username}`}>
              <td>{c.art}</td>
              <td>{c.name}</td>
              <td>{c.klasse}</td>
              <td className="font-mono">{c.username}</td>
              <td className="font-mono">{c.password || <span className="font-sans text-muted">Zugang besteht</span>}</td>
              <td>{c.kind}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/**
 * Q5-21: Sammelknopf „Startpasswörter neu erzeugen“ – solange der Schuljahreswechsel läuft, für die im Schritt „Neuaufnahmen“
 * angelegten Konten ohne eigenes Passwort (z. B. wenn die Liste nach dem Übernehmen nicht gespeichert wurde).
 */
export function RegeneratePasswords({ transitionId, count }: { transitionId: string; count: number }) {
  const [state, formAction, pending] = useActionState<RegeneratePasswordsState, FormData>(regeneratePasswordsAction, {});
  if (state.ok && state.list) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="font-semibold text-success">
          {state.list.length} Startpasswörter neu erzeugt
          {state.skipped ? ` · ${state.skipped} Konten unverändert (schon eigenes Passwort, gesperrt oder gelöscht)` : ""}
        </p>
        <CredentialsView credentials={state.list} csv={state.csv ?? ""} />
      </div>
    );
  }
  return (
    <form action={formAction} aria-label="Startpasswörter neu erzeugen" className="flex flex-col gap-3">
      <input type="hidden" name="transitionId" value={transitionId} />
      <p className="text-sm text-muted">
        Der Schritt „Neuaufnahmen“ hat {count} Konten angelegt. Ging die Liste der Startpasswörter verloren, lassen sie sich hier für alle
        Konten neu erzeugen, die noch kein eigenes Passwort gesetzt haben. Vorhandene, verknüpfte Elternkonten bleiben unverändert.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" value="1" className="mt-0.5 size-4 accent-[var(--accent)]" />
        Die bisher ausgegebenen Startpasswörter dieser Konten werden ungültig.
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Bitte warten …" : "Startpasswörter neu erzeugen"}
        </Button>
      </div>
    </form>
  );
}
