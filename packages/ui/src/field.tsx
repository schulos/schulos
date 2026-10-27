"use client";

import { cloneElement, isValidElement, useId } from "react";
import { cn } from "./cn";

const control =
  "w-full rounded-xl border border-border bg-surface px-3 text-base text-ink outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60 aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-11", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24 py-2.5", className)} {...props} />;
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(control, "h-11", className)} {...props} />;
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * Beschriftetes Formularfeld. Hinweis und Fehler hängen per aria-describedby am Feld –
 * sie gehören NICHT zum Label (sonst wird „Vorname" auch im Hinweis „vorname.nachname" gefunden).
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactElement<ControlProps>;
  className?: string;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  // Aus einer Server-Komponente kann das Kind beim Streamen noch ein unaufgelöster Verweis sein (kein Element, keine `props`) –
  // dann nicht abstürzen; Formulare mit `Field` trotzdem als Client-Komponente bauen, sonst fehlt die Label-Verknüpfung.
  const childId = isValidElement(children) ? children.props?.id : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: childId ?? id,
        "aria-describedby": note ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={childId ?? id} className="text-sm font-medium">
        {label}
      </label>
      {control}
      {note && (
        <span id={noteId} className={cn("text-xs", error ? "text-danger" : "text-muted")}>
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * Segment-Schalter (Einfachauswahl als Knopfleiste, VT-03b): echte Radio-Knöpfe in einer Gruppe mit Legende – Pfeiltasten,
 * Screenreader und Formular verhalten sich wie bei Radio-Knöpfen. Der Knopf bleibt unsichtbar über dem Segment liegen.
 * `name` ist optional (ohne Namen wird nichts abgeschickt, die Auswahl führt der Aufrufer).
 */
export function Segmented<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  className,
}: {
  legend: string;
  name?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  className?: string;
}) {
  const group = useId();
  return (
    <fieldset className={cn("min-w-0 border-0 p-0", className)}>
      <legend className="mb-1.5 p-0 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className="relative flex min-h-11 cursor-pointer items-center rounded-xl border border-border bg-surface px-3 text-sm font-medium has-checked:border-accent has-checked:bg-accent-soft has-checked:text-accent-ink has-focus-visible:ring-2 has-focus-visible:ring-accent/40"
          >
            <input
              type="radio"
              name={name ?? group}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="absolute inset-0 cursor-pointer appearance-none opacity-0"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Knopfzeile in einem mehrspaltigen Formular-Raster aus `Field`s. Solche Raster richten sich oben aus (kein
 * `items-end`): Felder mit und ohne Hinweis/Fehler stehen dann auf einer Linie (#16). Ein leerer Platzhalter in
 * Label-Höhe setzt den Knopf auf Höhe der Eingabefelder; einspaltig (mobil) entfällt er.
 */
export function FieldActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span aria-hidden="true" className="hidden text-sm font-medium sm:block">
        &nbsp;
      </span>
      <div className="flex min-h-11 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
