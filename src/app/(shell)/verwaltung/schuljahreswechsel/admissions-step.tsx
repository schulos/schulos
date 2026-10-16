"use client";

import { Download, Printer } from "lucide-react";
import { startTransition, useActionState, useMemo, useState } from "react";
import type { AdmissionCredential } from "@/modules/anmeldung/uebernahme";
import { admissionsAction, regeneratePasswordsAction, type AdmissionsState, type RegeneratePasswordsState } from "@/modules/verwaltung/schuljahreswechsel-actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

export interface AdmissionRow {
  antragId: string;
  number: string;
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

/**
 * Schritt „Neuaufnahmen“ (P4-39): je Jahrgang die neuen Klassen (Kurznamen), je Kind die Klasse (Vorschlag vorbelegt;
 * Grundschule und Geschwister nur als Sortierhilfe) oder „nicht übernehmen“. Danach einmalig die Zugangsdaten als Liste,
 * CSV und Druck – nicht per Mail.
 */
export function AdmissionsStep({
  transitionId,
  canCreate,
  levels,
  rows,
  proposal,
}: {
  transitionId: string;
  /** Recht „Benutzer verwalten“ (Konten anlegen); ohne geht nur „Niemanden übernehmen“ */
  canCreate: boolean;
  levels: { level: number; name: string; classes: string[] }[];
  rows: AdmissionRow[];
  proposal: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState<AdmissionsState, FormData>(admissionsAction, {});
  const [classText, setClassText] = useState<Record<number, string>>(Object.fromEntries(levels.map((l) => [l.level, l.classes.join(", ")])));
  const options = useMemo(() => Object.fromEntries(levels.map((l) => [l.level, split(classText[l.level] ?? "")])), [levels, classText]);
  const [assign, setAssign] = useState<Record<string, string>>(proposal);
  const [skipAll, setSkipAll] = useState(false);

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
        (Familien zusammen, sonst gleichmäßig). Übernommen werden nur Name, Klasse und die E-Mail der Eltern; alles Weitere bleibt in der
        Schulverwaltungssoftware.
      </p>
      {levels.map((l) => (
        <Field key={l.level} label={`Neue Klassen ${l.name}`} hint="Kurznamen mit Komma, z. B. 5a, 5b, 5c – leere Klassen werden nicht angelegt" error={state.fieldErrors?.[`classes-${l.level}`]}>
          <Input name={`classes:${l.level}`} value={classText[l.level] ?? ""} onChange={(e) => setClassText((s) => ({ ...s, [l.level]: e.target.value }))} className="max-w-md" />
        </Field>
      ))}
      <Table aria-label="Zuordnung">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Grundschule</th>
            <th>Geschwister</th>
            <th>Elternkonto</th>
            <th>Klasse</th>
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
                <Select
                  name={`a:${r.antragId}`}
                  value={assign[r.antragId] ?? ""}
                  onChange={(e) => setAssign((s) => ({ ...s, [r.antragId]: e.target.value }))}
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
