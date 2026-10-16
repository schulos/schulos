"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ROLES, type Role } from "@/core/roles";
import { ROLE_LABELS } from "@/core/labels";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { Credentials } from "./credentials";

export interface UserFormValues {
  firstName: string;
  lastName: string;
  role: Role;
  shortCode: string | null;
  username: string | null;
  /** echte Adresse (ohne Platzhalter) */
  email?: string | null;
  emailVerified?: boolean;
  /** Sprechzeiten und Raum (Rolle Beratung) */
  officeHours?: string | null;
}

export function UserForm({
  action,
  initial,
  mode,
  roles = ROLES,
  roleHint,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial?: UserFormValues;
  mode: "create" | "edit";
  /** Rollen, die die angemeldete Person vergeben darf (SEC-04) */
  roles?: readonly Role[];
  /** Hinweis unter dem Rollenfeld, z. B. warum es gesperrt ist */
  roleHint?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [role, setRole] = useState<Role>(initial?.role ?? roles[0] ?? "schueler");
  const fe = state.fieldErrors ?? {};
  // nach einem Fehler mit den eingegebenen Werten neu aufbauen (key) – React setzt das Formular sonst zurück (TD-02)
  const v = state.values;

  if (mode === "create" && state.ok && state.credentials) {
    return (
      <div className="flex flex-col gap-4">
        <Credentials title="Benutzer angelegt" {...state.credentials} />
        <div className="flex gap-2">
          <Button asChild variant="primary">
            <Link href="/verwaltung/benutzer/neu">Weiteren anlegen</Link>
          </Button>
          <Button asChild>
            <Link href="/verwaltung/benutzer">Zur Liste</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form key={JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Vorname" error={fe.firstName}>
        <Input name="firstName" defaultValue={v?.firstName ?? initial?.firstName} required autoComplete="off" />
      </Field>
      <Field label="Nachname" error={fe.lastName}>
        <Input name="lastName" defaultValue={v?.lastName ?? initial?.lastName} required autoComplete="off" />
      </Field>
      <Field label="Rolle" hint={roleHint} error={fe.role}>
        <Select name="role" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={roles.length <= 1}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      {/* gesperrtes Auswahlfeld sendet nichts mit */}
      {roles.length <= 1 && <input type="hidden" name="role" value={role} />}
      {role === "lehrkraft" ? (
        <Field label="Kürzel" hint="2–4 Buchstaben, z. B. BRA" error={fe.shortCode}>
          <Input name="shortCode" defaultValue={v?.shortCode ?? initial?.shortCode ?? ""} maxLength={4} className="uppercase" />
        </Field>
      ) : role === "beratung" ? (
        <Field label="Sprechzeiten und Raum" hint="Erscheint im Adressbuch für Schüler:innen und Eltern, z. B. „Di + Do 9–12 Uhr, Raum A 0.14“ – die Person kann es auch selbst ändern" error={fe.officeHours}>
          <Input name="officeHours" defaultValue={v?.officeHours ?? initial?.officeHours ?? ""} maxLength={300} autoComplete="off" />
        </Field>
      ) : (
        <div className="hidden sm:block" />
      )}
      {mode === "create" ? (
        <Field label="Benutzername" hint="Leer lassen für vorname.nachname" error={fe.username}>
          <Input name="username" defaultValue={v?.username} autoComplete="off" />
        </Field>
      ) : (
        <Field label="Benutzername" hint="Kann nicht geändert werden">
          <Input value={initial?.username ?? ""} disabled readOnly />
        </Field>
      )}
      <Field
        label="E-Mail-Adresse"
        hint={
          role === "schueler"
            ? "Optional – bei Schüler:innen nur bei Bedarf"
            : initial?.email
              ? initial.emailVerified
                ? "Von der Person bestätigt"
                : "Noch nicht bestätigt – die Person kann sie unter „E-Mail-Adresse“ bestätigen"
              : "Optional – für Bestätigungslinks und Hinweise"
        }
        error={fe.email}
      >
        <Input name="email" type="email" defaultValue={v?.email ?? initial?.email ?? ""} autoComplete="off" />
      </Field>
      <div className="hidden sm:block" />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Speichern …" : mode === "create" ? "Anlegen" : "Speichern"}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {mode === "edit" && state.ok && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
      </div>
    </form>
  );
}
