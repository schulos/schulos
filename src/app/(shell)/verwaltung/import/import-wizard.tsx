"use client";

import { CheckCircle2, Download, FileUp, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { previewImportAction, runImportAction, type PreviewResult } from "@/modules/verwaltung/import-actions";
import type { ImportResult } from "@/modules/verwaltung/import";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Textarea } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

const students = (n: number) => `${n} ${n === 1 ? "Schüler:in" : "Schüler:innen"}`;

const EXAMPLE = "Vorname;Nachname;Klasse\nMia;Beispiel;5a\nNoah;Muster;5b";

export function ImportWizard() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<(ImportResult & { csv: string }) | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const okCount = preview?.plan.filter((p) => !p.error).length ?? 0;
  const badCount = (preview?.plan.length ?? 0) - okCount + (preview?.parseErrors.length ?? 0);

  if (result) {
    const url = `data:text/csv;charset=utf-8,${encodeURIComponent(result.csv)}`;
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="flex items-center gap-2 font-semibold text-success">
          <CheckCircle2 className="size-5" aria-hidden /> {students(result.created.length)} angelegt
          {result.skipped > 0 && `, ${result.skipped} übersprungen`}
        </p>
        <p className="text-sm text-muted">Die Startpasswörter werden nur jetzt angezeigt – Liste herunterladen und sicher weitergeben.</p>
        <Button asChild variant="primary" className="self-start">
          <a href={url} download="zugangsdaten.csv">
            <Download aria-hidden /> Zugangsdaten herunterladen (CSV)
          </a>
        </Button>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Klasse</th>
              <th>Benutzername</th>
              <th>Startpasswort</th>
            </tr>
          </thead>
          <tbody>
            {result.created.map((c) => (
              <tr key={c.username}>
                <td>{c.name}</td>
                <td>{c.klasse}</td>
                <td className="font-mono">{c.username}</td>
                <td className="font-mono">{c.password}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Button
          className="self-start"
          onClick={() => {
            setResult(null);
            setPreview(null);
            setText("");
          }}
        >
          Neuer Import
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        Spalten <strong className="text-ink">Vorname; Nachname; Klasse</strong> und optional Benutzername. Kopfzeile, Semikolon oder Komma werden
        automatisch erkannt. Fehlt der Benutzername, wird <code>vorname.nachname</code> vergeben. Eine Spalte <strong className="text-ink">E-Mail</strong>
        (nur mit Kopfzeile) ist optional und bei Schüler:innen in der Regel leer. Eine Spalte <strong className="text-ink">Eigenständig</strong> (nur
        mit Kopfzeile, „ja“/„x“) kennzeichnet volljährige Schüler:innen, die selbst handeln – ihre Eltern sehen dann nichts.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-4 font-medium hover:bg-surface-2">
          <FileUp className="size-[18px]" aria-hidden /> CSV-Datei wählen
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                setText(await file.text());
                setPreview(null);
              }
            }}
          />
        </label>
        <Button variant="ghost" size="sm" onClick={() => setText(EXAMPLE)}>
          Beispiel einfügen
        </Button>
      </div>
      <Field label="CSV-Inhalt">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          rows={8}
          className="font-mono text-sm"
          placeholder={EXAMPLE}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!text.trim() || pending}
          onClick={() =>
            start(async () => {
              setError(undefined);
              const res = await previewImportAction(text);
              setPreview(res);
              setError(res.error);
            })
          }
        >
          Vorschau
        </Button>
        {preview && okCount > 0 && (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await runImportAction(text);
                if ("error" in res) setError(res.error);
                else setResult(res);
              })
            }
          >
            {students(okCount)} importieren
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {preview && (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap gap-2 text-sm">
            <Badge tone="success">{okCount} bereit</Badge>
            {badCount > 0 && (
              <Badge tone="danger">
                <TriangleAlert className="size-3" aria-hidden /> {badCount} mit Fehler (werden übersprungen)
              </Badge>
            )}
          </p>
          {preview.parseErrors.map((e) => (
            <p key={e.line} className="text-sm text-danger">
              Zeile {e.line}: {e.message}
            </p>
          ))}
          <Table>
            <thead>
              <tr>
                <th>Zeile</th>
                <th>Name</th>
                <th>Klasse</th>
                <th>Benutzername</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.plan.map((p) => (
                <tr key={p.line}>
                  <td className="text-muted tabular-nums">{p.line}</td>
                  <td>
                    {p.firstName} {p.lastName}
                    {p.selfResponsible && (
                      <Badge tone="soft" className="ml-2">
                        eigenständig
                      </Badge>
                    )}
                  </td>
                  <td>{p.groupName ?? p.klasse}</td>
                  <td className="font-mono">{p.username}</td>
                  <td>{p.error ? <span className="text-danger">{p.error}</span> : <Badge tone="success">OK</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
