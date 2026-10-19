import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { cancelInspectionAction, planInspectionAction, recordInspectionAction, runRemindersAction } from "@/modules/gebaeude/actions";
import { INSPECTION_RESULTS, INSPECTION_STATE_LABELS, INSPECTION_TARGET_LABELS, MAX_REPORT_MB, RESPONSIBLE_LABELS, RESULT_LABELS, type InspectionState } from "@/modules/gebaeude/labels";
import { canConfigure, formatDay, inspectionBuildings, inspectionSummary, listAssets, listInspections, listInspectionTypes, roomOptions, type InspectionFilter } from "@/modules/gebaeude/pruefungen";
import { canManage, canViewAll } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { SpecForm } from "@/ui/spec-form";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Prüfungen" };

const STATE_TONE: Record<InspectionState, "danger" | "warn" | "neutral" | "success"> = { ueberfaellig: "danger", faellig: "warn", geplant: "neutral", erledigt: "success" };
const STATES = [
  { value: "offen", label: "offen" },
  { value: "ueberfaellig", label: "überfällig" },
  { value: "faellig", label: "bald fällig" },
  { value: "erledigt", label: "erledigt" },
] as const;

type Search = { stand?: string; art?: string; gebaeude?: string };

/** Prüfungen: Fälligkeiten (überfällig/bald fällig/geplant), erledigte Nachweise, Erfassen und Planen. */
export default async function PruefungenPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canViewAll(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  const state = (STATES.find((s) => s.value === sp.stand)?.value ?? "offen") as NonNullable<InspectionFilter["state"]>;
  const [types, buildings] = await Promise.all([listInspectionTypes(db), inspectionBuildings(db)]);
  const typeId = types.find((t) => t.id === sp.art)?.id;
  const building = buildings.find((b) => b === sp.gebaeude);
  const manage = canManage(perms);
  const [rows, summary, assets, rooms] = await Promise.all([
    listInspections(db, perms, { state, typeId, building }, today),
    inspectionSummary(db, perms, today),
    manage ? listAssets(db, perms) : Promise.resolve([]),
    manage ? roomOptions(db) : Promise.resolve([]),
  ]);
  const activeTypes = types.filter((t) => t.active);
  const query = new URLSearchParams({ ...(building ? { gebaeude: building } : {}), ...(typeId ? { art: typeId } : {}) }).toString();

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Prüfungen"
        actions={
          <>
            <Button asChild>
              <Link href={`/druck/pruefliste${query ? `?${query}` : ""}`}>Prüfliste drucken</Link>
            </Button>
            <Button asChild>
              <a href="/api/gebaeude/export/pruefungen" download>
                CSV
              </a>
            </Button>
          </>
        }
      />
      <GebaeudeNav current="pruefungen" configure={canConfigure(perms)} />
      <p className="text-sm text-muted">
        Fristen und Quellen der Prüfarten sind eine Vorlage zum Prüfen – maßgeblich sind die Vorgaben von Schulträger und Fachkraft für Arbeitssicherheit.
      </p>
      <div className="flex flex-wrap gap-2" aria-label="Stand">
        <Link href="/gebaeude/pruefungen?stand=ueberfaellig">
          <Badge tone={summary.overdue ? "danger" : "neutral"}>{summary.overdue} überfällig</Badge>
        </Link>
        <Link href="/gebaeude/pruefungen?stand=faellig">
          <Badge tone={summary.due ? "warn" : "neutral"}>{summary.due} bald fällig</Badge>
        </Link>
        <Badge tone="neutral">{summary.open} offen insgesamt</Badge>
      </div>

      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
        <Field label="Stand">
          <Select name="stand" defaultValue={state} className="w-40">
            {STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prüfart">
          <Select name="art" defaultValue={typeId ?? ""} className="w-72">
            <option value="">alle</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.active ? "" : " (aus)"}
              </option>
            ))}
          </Select>
        </Field>
        {buildings.length > 0 && (
          <Field label="Gebäude">
            <Select name="gebaeude" defaultValue={building ?? ""} className="w-48">
              <option value="">alle</option>
              {buildings.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
        )}
        <Button type="submit">Filtern</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="Keine Prüfungen">
          {activeTypes.length === 0 ? "Noch keine Prüfart eingeschaltet – das geht unter Gebäude & Technik → Prüfarten." : "Für diesen Filter gibt es nichts."}
        </EmptyState>
      ) : (
        <ul aria-label="Prüfungen" className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {r.typeName}: {r.target}
                  </span>
                  <span className="text-xs text-muted">
                    {[r.roomId && r.assetName ? `Raum ${r.roomId}` : null, r.building, RESPONSIBLE_LABELS[r.responsible]].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {r.doneOn ? (
                    <>
                      <span>geprüft {formatDay(r.doneOn)}</span>
                      <Badge tone={r.result === "ok" ? "success" : r.result ? "danger" : "neutral"}>{r.result ? RESULT_LABELS[r.result] : "übernommen"}</Badge>
                      {r.company && <span className="text-muted">{r.company}</span>}
                      {r.hasReport && (
                        <a href={`/api/gebaeude/protokoll/${r.id}`} className="font-medium text-accent-ink hover:underline">
                          Protokoll (PDF)
                        </a>
                      )}
                      {r.ticketId && (
                        <Link href={`/gebaeude/${r.ticketId}`} className="font-medium text-accent-ink hover:underline">
                          Meldung
                        </Link>
                      )}
                    </>
                  ) : (
                    <>
                      <span>fällig {formatDay(r.dueOn)}</span>
                      <Badge tone={STATE_TONE[r.state]}>{INSPECTION_STATE_LABELS[r.state]}</Badge>
                    </>
                  )}
                </div>
              </div>
              {manage && !r.doneOn && (
                <details className="rounded-lg bg-surface-2 px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium">Ergebnis erfassen</summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <SpecForm
                      action={recordInspectionAction.bind(null, r.id)}
                      label={`Prüfung erfassen: ${r.typeName}: ${r.target}`}
                      submit="Prüfung erfassen"
                      okText="Erfasst."
                      columns={3}
                      fields={[
                        { name: "doneOn", label: "geprüft am", type: "date", defaultValue: today, required: true },
                        { name: "result", label: "Ergebnis", type: "select", defaultValue: "ok", options: INSPECTION_RESULTS.map((x) => ({ value: x, label: RESULT_LABELS[x] })) },
                        { name: "company", label: "Firma bzw. Stelle", type: "text", hint: "kein Personenname", maxLength: 120 },
                        { name: "report", label: "Protokoll (PDF)", type: "file", accept: "application/pdf", hint: `optional, höchstens ${MAX_REPORT_MB} MB` },
                        { name: "note", label: "Bemerkung", type: "textarea", wide: true, maxLength: 2000, hint: "bei Mangel: was ist zu tun? – daraus entsteht eine Meldung" },
                      ]}
                    />
                    <form action={cancelInspectionAction.bind(null, r.id)}>
                      <Button type="submit" size="sm" variant="ghost">
                        Prüfung streichen
                      </Button>
                    </form>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {manage && activeTypes.length > 0 && (
        <Card aria-labelledby="planen">
          <CardHeader title={<span id="planen">Prüfung planen</span>} />
          <p className="text-sm text-muted">
            Prüfungen von Anlagen plant SchulOS selbst (letzte Prüfung + Intervall). Hier lassen sich Raum- und Gebäudeprüfungen oder abweichende Termine anlegen – je
            nach Prüfart Anlage, Raum oder Gebäude angeben.
            {/* Q5-29: wer keine Prüfarten pflegt, soll wissen, wo das Intervall herkommt */}
            {!canConfigure(perms) && " Intervalle je Prüfart legt die Verwaltung fest (Gebäude & Technik → Prüfarten)."}
          </p>
          <SpecForm
            action={planInspectionAction}
            label="Prüfung planen"
            submit="Planen"
            okText="Geplant."
            columns={3}
            fields={[
              { name: "typeId", label: "Prüfart", type: "select", options: activeTypes.map((t) => ({ value: t.id, label: `${t.name} (${INSPECTION_TARGET_LABELS[t.appliesTo]})` })) },
              { name: "dueOn", label: "fällig am", type: "date", defaultValue: today, required: true },
              { name: "assetId", label: "Anlage", type: "select", options: [{ value: "", label: "–" }, ...assets.map((a) => ({ value: a.id, label: a.inventoryNo ? `${a.name} (${a.inventoryNo})` : a.name }))] },
              { name: "roomId", label: "Raum", type: "select", options: [{ value: "", label: "–" }, ...rooms] },
              { name: "building", label: "Gebäude", type: "text", maxLength: 60, placeholder: buildings[0] ?? "Hauptgebäude" },
            ]}
          />
        </Card>
      )}
      {canConfigure(perms) && (
        <Card aria-labelledby="erinnern">
          <CardHeader title={<span id="erinnern">Erinnerungen</span>} />
          <p className="text-sm text-muted">
            Jede Nacht um 4 Uhr: bald fällige Prüfungen (Vorwarnzeit der Prüfart) einmal je Woche, überfällige täglich als Gong an alle, die Prüfungen erfassen – überfällige
            zusätzlich als Alarm-Mail, wenn E-Mail eingerichtet ist.
          </p>
          <SpecForm action={runRemindersAction} label="Fristen prüfen" submit="Fristen jetzt prüfen" fields={[]} columns={1} variant="secondary" />
        </Card>
      )}
    </main>
  );
}
