"use client";

import Link from "next/link";
import { DoorOpen, FileArchive, KeyRound, Lock, LockOpen, Trash2, Undo2 } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { reactivateAccountAction, setAccountLeftAction } from "@/core/privacy/actions";
import { resetPasswordAction, setLockedAction, type FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { Credentials } from "../credentials";

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmt = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

export function UserActions({
  id,
  locked,
  isSelf,
  leftOn,
  deleteFrom,
  erasureRequested,
  today,
  canPrivacy,
  blocked = null,
}: {
  id: string;
  locked: boolean;
  isSelf: boolean;
  /** Abgangsdatum (Konto-Lebenszyklus) */
  leftOn: string | null;
  /** ab diesem Tag löscht der Löschlauf das Konto */
  deleteFrom: string | null;
  erasureRequested: boolean;
  today: string;
  canPrivacy: boolean;
  /** SEC-04: Grund, warum dieses Konto nur ein Admin verwalten darf – dann keine Knöpfe */
  blocked?: string | null;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FormState>({});
  const [leftState, leftAction, leftPending] = useActionState(setAccountLeftAction.bind(null, id), {});
  const [showLeft, setShowLeft] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {leftOn ? (
          <>
            Abgang am {fmt(leftOn)} – das Konto ist gesperrt.{" "}
            {erasureRequested ? "Löschung auf Antrag vorgemerkt." : deleteFrom && <>Der Löschlauf löscht es ab {fmt(deleteFrom)}.</>}
          </>
        ) : locked ? (
          "Das Konto ist gesperrt – Anmeldung nicht möglich."
        ) : (
          "Das Konto ist aktiv."
        )}
      </p>
      {blocked ? (
        <p className="text-sm text-muted">{blocked}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {leftOn ? (
            <Button disabled={pending} onClick={() => start(async () => setResult(await reactivateAccountAction(id)))}>
              <Undo2 aria-hidden /> Abgang zurücknehmen
            </Button>
          ) : locked ? (
            <Button disabled={pending} onClick={() => start(async () => setResult(await setLockedAction(id, false)))}>
              <LockOpen aria-hidden /> Entsperren
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={pending || isSelf}
              title={isSelf ? "Du kannst dich nicht selbst sperren" : undefined}
              onClick={() => {
                if (confirm("Konto wirklich sperren? Alle Sitzungen werden sofort beendet.")) {
                  start(async () => setResult(await setLockedAction(id, true)));
                }
              }}
            >
              <Lock aria-hidden /> Sperren
            </Button>
          )}
          {!leftOn && !isSelf && (
            <Button variant="ghost" onClick={() => setShowLeft((v) => !v)} aria-expanded={showLeft}>
              <DoorOpen aria-hidden /> Abgang eintragen
            </Button>
          )}
          <Button
            disabled={pending}
            onClick={() => {
              if (confirm("Neues Passwort erzeugen? Das alte wird sofort ungültig.")) {
                start(async () => setResult(await resetPasswordAction(id)));
              }
            }}
          >
            <KeyRound aria-hidden /> Passwort zurücksetzen
          </Button>
        </div>
      )}
      {showLeft && !leftOn && !blocked && (
        <form action={leftAction} aria-label="Abgang eintragen" className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
          <Field label="Abgang am" error={leftState.fieldErrors?.leftOn}>
            <Input type="date" name="leftOn" defaultValue={today} required />
          </Field>
          <Button type="submit" variant="danger" disabled={leftPending}>
            Abgang speichern
          </Button>
          <p className="basis-full text-xs text-muted">
            Sperrt das Konto sofort. Nach 90 Tagen löscht der Löschlauf es; Elternkonten ohne weiteres aktives Kind folgen.
          </p>
        </form>
      )}
      {canPrivacy && (
        // POST statt Link (SEC-05): Bilder/Vorabrufe lösen keine Auskunft aus
        <form method="post" action={`/api/datenschutz/auskunft/${encodeURIComponent(id)}`}>
          <button type="submit" className="inline-flex cursor-pointer items-center gap-1.5 text-sm hover:underline">
            <FileArchive aria-hidden className="size-4" /> Auskunft (Art. 15) als ZIP herunterladen
          </button>
        </form>
      )}
      {canPrivacy && !isSelf && !blocked && (
        <Link href={`/verwaltung/benutzer/${encodeURIComponent(id)}/loeschen`} className="inline-flex items-center gap-1.5 text-sm text-danger hover:underline">
          <Trash2 aria-hidden className="size-4" /> Löschung auf Antrag (Art. 17) …
        </Link>
      )}
      {result.error && (
        <p role="alert" className="text-sm text-danger">
          {Object.values(result.fieldErrors ?? {})[0] ?? result.error}
        </p>
      )}
      {result.credentials && <Credentials title="Neues Passwort" username="" password={result.credentials.password} />}
    </div>
  );
}
