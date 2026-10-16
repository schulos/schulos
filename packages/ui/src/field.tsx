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
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        "aria-describedby": note ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={children.props.id ?? id} className="text-sm font-medium">
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
