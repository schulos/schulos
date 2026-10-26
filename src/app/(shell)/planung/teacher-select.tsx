"use client";

import { useState } from "react";
import { rankTeachers, subjectFit, type PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { Field, Select } from "@schulos/ui/field";

const hoursFmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

function restLabel(rest: number): string {
  if (rest === 0) return "Deputat voll";
  return rest > 0 ? `Rest ${hoursFmt.format(rest)} Std.` : `${hoursFmt.format(-rest)} Std. über Soll`;
}

const optionLabel = (t: PickTeacher, suffix = "") => `${t.code ?? "–"} – ${t.name} · ${restLabel(t.rest)}${suffix}`;

/**
 * SP2-12: Lehrkraft für ein Fach zuweisen. Vorgeschlagen werden nur Lehrkräfte mit dem Fach als Lehrfach, sortiert nach Restdeputat
 * (Soll − Lehraufträge), dann Name. Weitere nur über „alle anzeigen“ – fachfremde mit Warnhinweis, ohne gepflegte Lehrfächer mit
 * Hinweis. Fachfremd speichern geht, braucht aber das Häkchen „Trotzdem zuweisen“ (`offSubjectOk`, prüft auch der Server).
 */
export function TeacherSelect({
  name,
  label,
  hint,
  error,
  emptyLabel,
  subjectId,
  subjectName,
  teachers,
  defaultValue,
  confirmed,
  className,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  emptyLabel: string;
  /** gewähltes Fach (leer = noch keins – dann alle) */
  subjectId: string;
  subjectName: string;
  teachers: PickTeacher[];
  defaultValue: string;
  /** „Trotzdem zuweisen“ war beim letzten Absenden angekreuzt (Formular nach einem Fehler) */
  confirmed?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const ranked = rankTeachers(teachers, subjectId || null);
  const chosen = teachers.find((t) => t.id === value);
  const fit = chosen && subjectId ? subjectFit(chosen.subjectIds, subjectId) : "fits";
  // Eine schon gewählte fachfremde Lehrkraft (z. B. beim Bearbeiten) bleibt sichtbar – dann gleich alle zeigen
  const [showAll, setShowAll] = useState(fit !== "fits");
  const hidden = ranked.unmaintained.length + ranked.others.length;
  const visible = (list: PickTeacher[]) => (showAll ? list : list.filter((t) => t.id === value));
  const unmaintained = visible(ranked.unmaintained);
  const others = visible(ranked.others);
  const who = chosen ? (chosen.code ?? chosen.name) : "";
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`} data-teacher-select={name}>
      <Field label={label} hint={hint} error={error}>
        <Select name={name} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{emptyLabel}</option>
          {subjectId ? (
            ranked.matching.length > 0 && (
              <optgroup label={`unterrichten ${subjectName}`}>
                {ranked.matching.map((t) => (
                  <option key={t.id} value={t.id}>
                    {optionLabel(t)}
                  </option>
                ))}
              </optgroup>
            )
          ) : (
            ranked.matching.map((t) => (
              <option key={t.id} value={t.id}>
                {optionLabel(t)}
              </option>
            ))
          )}
          {unmaintained.length > 0 && (
            <optgroup label="ohne gepflegte Lehrfächer">
              {unmaintained.map((t) => (
                <option key={t.id} value={t.id}>
                  {optionLabel(t, " · Lehrfächer fehlen")}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label={`unterrichten ${subjectName} laut Stammdaten nicht`}>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {optionLabel(t, " · fachfremd")}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {subjectId && hidden > 0 && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          alle anzeigen ({hidden} weitere)
        </label>
      )}
      {subjectId && ranked.matching.length === 0 && (
        <p className="text-sm text-warn">Keine Lehrkraft hat {subjectName} als Lehrfach – Lehrfächer in den Stammdaten der Lehrkräfte pflegen oder „alle anzeigen“.</p>
      )}
      {fit === "off" && (
        <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          <span>
            {who} unterrichtet {subjectName} laut Stammdaten nicht.
          </span>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" name="offSubjectOk" value="1" defaultChecked={confirmed} className="size-4 accent-[var(--accent)]" />
            Trotzdem zuweisen
          </label>
        </div>
      )}
      {fit === "unmaintained" && <p className="text-sm text-muted">Für {who} sind noch keine Lehrfächer gepflegt – bitte in den Stammdaten der Lehrkraft nachtragen.</p>}
    </div>
  );
}
