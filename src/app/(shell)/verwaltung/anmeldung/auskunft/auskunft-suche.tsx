"use client";

import { useActionState } from "react";
import { auskunftSearchAction, type AuskunftSearchState } from "@/modules/anmeldung/actions";
import { ANTRAG_STATUS_LABELS } from "@/modules/anmeldung/labels";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });

/** Suche per Vorgangsnummer/E-Mail, je Treffer „JSON herunterladen“ (POST an die Auskunfts-Route). */
export function AuskunftSuche() {
  const [state, action, pending] = useActionState<AuskunftSearchState, FormData>(auskunftSearchAction, {});
  return (
    <div className="flex flex-col gap-4">
      <form action={action} aria-label="Auskunft suchen" className="flex flex-wrap items-end gap-3">
        <Field label="Vorgangsnummer oder E-Mail-Adresse" hint="genau, z. B. A-2027-0042 oder name@example.org">
          <Input name="q" defaultValue={state.query ?? ""} required className="w-80" autoComplete="off" />
        </Field>
        <Button type="submit" disabled={pending}>
          Suchen
        </Button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.results &&
        (state.results.length === 0 ? (
          <p role="status" className="text-sm text-muted">
            Kein Antrag zu dieser Angabe.
          </p>
        ) : (
          <section aria-label="Treffer">
            <Table>
              <thead>
                <tr>
                  <th>Vorgang</th>
                  <th>Kind</th>
                  <th>Verfahren</th>
                  <th>Stand</th>
                  <th>Eingang</th>
                  <th className="text-right">Auskunft</th>
                </tr>
              </thead>
              <tbody>
                {state.results.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium tabular-nums">
                      {r.number}
                      {r.via === "elternteil2" && (
                        <span className="block text-xs font-normal text-muted">über Elternteil 2 – Adresse unbestätigt, nur eingeschränkte Auskunft</span>
                      )}
                    </td>
                    <td>{r.childName}</td>
                    <td className="text-sm">{r.verfahrenName}</td>
                    <td className="text-sm">{ANTRAG_STATUS_LABELS[r.status]}</td>
                    <td className="text-sm whitespace-nowrap">{day.format(new Date(r.createdAt))}</td>
                    <td className="text-right">
                      {/* R-05: Suchbegriff mitschicken – der Server legt daraus den Umfang fest */}
                      <form method="post" action={`/api/verwaltung/anmeldung-auskunft/${encodeURIComponent(r.id)}`} className="inline-flex flex-wrap justify-end gap-2">
                        <input type="hidden" name="q" value={state.query ?? ""} />
                        {r.via === "vorgangsnummer" && r.hasParent2 ? (
                          <>
                            <Button type="submit" size="sm" name="umfang" value="voll" aria-label={`Auskunft ${r.number} als JSON (voll, Elternteil 1)`}>
                              Voll – Elternteil 1
                            </Button>
                            <Button type="submit" size="sm" variant="secondary" name="umfang" value="elternteil2" aria-label={`Auskunft ${r.number} als JSON (eingeschränkt, Elternteil 2)`}>
                              Eingeschränkt – Elternteil 2
                            </Button>
                          </>
                        ) : (
                          <Button type="submit" size="sm" aria-label={`Auskunft ${r.number} als JSON`}>
                            JSON herunterladen
                          </Button>
                        )}
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        ))}
    </div>
  );
}
