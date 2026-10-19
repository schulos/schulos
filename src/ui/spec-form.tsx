"use client";

import { useActionState } from "react";
import { checkedAfter, listAfter } from "@/core/form-values";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { cn } from "@schulos/ui/cn";

type Option = { value: string; label: string };

/** Feldbeschreibung als Daten – so bleiben Eingaben nach einem Fehler erhalten (FormState.values + key). */
export interface FieldSpec {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "datetime-local" | "select" | "multiselect" | "textarea" | "checkbox" | "file";
  options?: Option[];
  defaultValue?: string;
  /** checkbox: Vorgabe angehakt */
  checked?: boolean;
  hint?: string;
  required?: boolean;
  /** über beide Spalten */
  wide?: boolean;
  accept?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  maxLength?: number;
}

/**
 * Formular aus Feldbeschreibungen für Pflegeseiten (Gebäude & Technik, Bücherei).
 * Erfolgsmeldung: `okText` oder `values.result` aus der Action.
 */
export function SpecForm({
  action,
  label,
  fields,
  submit,
  okText,
  columns = 2,
  variant = "primary",
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  label: string;
  fields: FieldSpec[];
  submit: string;
  okText?: string;
  columns?: 1 | 2 | 3;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  const v = state.ok ? undefined : state.values;
  const grid = columns === 1 ? "" : columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2";
  const okMessage = state.ok ? (state.values?.result ?? okText) : undefined;
  return (
    <form key={`${String(state.ok ?? "")}${JSON.stringify(state.values ?? null)}`} action={formAction} aria-label={label} className={cn("grid gap-3", grid)}>
      {fields.map((f) => {
        const value = v?.[f.name] ?? f.defaultValue ?? "";
        const span = f.wide ? (columns === 3 ? "sm:col-span-2 lg:col-span-3" : "sm:col-span-2") : "";
        if (f.type === "checkbox")
          return (
            <label key={f.name} className={cn("flex min-h-11 items-center gap-2 self-end text-sm", span)}>
              <input type="checkbox" name={f.name} defaultChecked={checkedAfter(v, f.name, f.checked)} className="size-4 accent-[var(--accent)]" />
              {f.label}
              {f.hint && <span className="text-xs text-muted">({f.hint})</span>}
            </label>
          );
        const control =
          f.type === "select" ? (
            <Select name={f.name} defaultValue={value} required={f.required}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : f.type === "multiselect" ? (
            <Select name={f.name} multiple defaultValue={listAfter(v, f.name, f.defaultValue ? f.defaultValue.split(",") : [])} className="h-32">
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : f.type === "textarea" ? (
            <Textarea name={f.name} defaultValue={value} maxLength={f.maxLength} placeholder={f.placeholder} className="min-h-20" />
          ) : f.type === "file" ? (
            <Input type="file" name={f.name} accept={f.accept} className="py-2" />
          ) : (
            <Input
              type={f.type}
              name={f.name}
              defaultValue={value}
              required={f.required}
              placeholder={f.placeholder}
              min={f.min}
              max={f.max}
              maxLength={f.maxLength}
            />
          );
        return (
          <Field key={f.name} label={f.label} hint={f.hint} error={fe[f.name]} className={span}>
            {control}
          </Field>
        );
      })}
      <div className={cn("flex flex-wrap items-center gap-3", columns === 1 ? "" : columns === 3 ? "sm:col-span-2 lg:col-span-3" : "sm:col-span-2")}>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? "Speichern …" : submit}
        </Button>
        {state.error && !Object.keys(fe).some((k) => fields.some((f) => f.name === k)) && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.error && Object.keys(fe).some((k) => fields.some((f) => f.name === k)) && (
          <p role="alert" className="text-sm text-danger">
            Bitte die markierten Felder prüfen.
          </p>
        )}
        {okMessage && (
          <p role="status" className="text-sm text-success">
            {okMessage}
          </p>
        )}
      </div>
    </form>
  );
}
