"use client";

// Anmelde- und Zwei-Faktor-Formulare, gemeinsam für SchulOS und SchulOS Backup.
// Die Server Actions kommen als Props aus der jeweiligen App (dort mit deren Auth-Instanz).
import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "./button";
import { Field, Input } from "./field";

/** Signatur einer Server Action für useActionState. */
export type FormAction<S> = (prev: S, form: FormData) => Promise<S>;

export interface LoginState {
  error?: string;
}

export interface SecondFactorState {
  error?: string;
  expired?: boolean;
}

export interface PasswordFormState {
  fieldErrors?: Partial<Record<"current" | "next" | "repeat", string>>;
}

export interface TwoFactorFormState {
  error?: string;
  setup?: { qrSvg: string; secret: string; backupCodes: string[] };
  codes?: string[];
}

export function LoginForm({ action, next }: { action: FormAction<LoginState>; next?: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next ?? "/"} />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Benutzername
        <input
          name="username"
          autoComplete="username"
          required
          autoFocus
          className="h-11 rounded-xl border border-border bg-surface px-3 text-base font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Passwort
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-11 rounded-xl border border-border bg-surface px-3 text-base font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </label>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-xl bg-accent font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-60"
      >
        {pending ? "Anmelden …" : "Anmelden"}
      </button>
    </form>
  );
}

const inputCls =
  "h-11 rounded-xl border border-border bg-surface px-3 text-base font-normal tracking-widest outline-none focus:border-accent focus:ring-2 focus:ring-accent/25";

export function SecondFactorForm({ action, next }: { action: FormAction<SecondFactorState>; next: string }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [backup, setBackup] = useState(false);
  return (
    <form action={formAction} className="flex flex-col gap-4" aria-label="Zweiter Faktor">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="mode" value={backup ? "backup" : "totp"} />
      {backup ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Wiederherstellungscode
          <input key="backup" name="code" autoComplete="off" required autoFocus className={inputCls} />
        </label>
      ) : (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Code aus der Authenticator-App
          <input
            key="totp"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            autoFocus
            className={inputCls}
          />
        </label>
      )}
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
          {state.expired && (
            <>
              {" "}
              <Link href="/login" className="font-medium underline">
                Zur Anmeldung
              </Link>
            </>
          )}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-xl bg-accent font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-60"
      >
        {pending ? "Prüfen …" : "Bestätigen"}
      </button>
      <button type="button" onClick={() => setBackup(!backup)} className="text-sm text-muted underline-offset-2 hover:underline">
        {backup ? "Code aus der App verwenden" : "Gerät nicht zur Hand? Wiederherstellungscode verwenden"}
      </button>
    </form>
  );
}

function ErrorNote({ state }: { state: TwoFactorFormState }) {
  return state.error ? (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {state.error}
    </p>
  ) : null;
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        <strong>Wiederherstellungscodes</strong> – jetzt ausdrucken oder sicher notieren. Jeder Code gilt einmal, falls das Gerät fehlt.
        Sie werden nur dieses eine Mal angezeigt.
      </p>
      <ul aria-label="Wiederherstellungscodes" className="grid grid-cols-2 gap-1.5 rounded-xl bg-surface-2 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function PasswordField() {
  return (
    <Field label="Passwort zur Bestätigung">
      <Input name="password" type="password" autoComplete="current-password" required />
    </Field>
  );
}

/** Einrichtung in zwei Schritten: Passwort → QR-Code + Codes → erster Code aus der App. */
export function SetupPanel(props: { start: FormAction<TwoFactorFormState>; confirm: FormAction<TwoFactorFormState> }) {
  const [start, startAction, starting] = useActionState(props.start, {});
  const [confirm, confirmAction, confirming] = useActionState(props.confirm, {});

  if (!start.setup)
    return (
      <form action={startAction} aria-label="Einrichtung starten" className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Du brauchst eine Authenticator-App auf dem Smartphone (z. B. Aegis, FreeOTP, Google oder Microsoft Authenticator).
        </p>
        <PasswordField />
        <ErrorNote state={start} />
        <div>
          <Button type="submit" variant="primary" disabled={starting}>
            {starting ? "Bitte warten …" : "Einrichtung starten"}
          </Button>
        </div>
      </form>
    );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-5">
        <div
          role="img"
          aria-label="QR-Code für die Authenticator-App"
          className="size-44 shrink-0 rounded-xl bg-white p-1 [&_svg]:size-full"
          dangerouslySetInnerHTML={{ __html: start.setup.qrSvg }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
          <p>1. QR-Code mit der Authenticator-App scannen.</p>
          <p className="text-muted">Oder das Geheimnis von Hand eingeben (zeitbasiert, 6 Stellen, 30 Sekunden):</p>
          <code aria-label="Geheimnis" className="rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-sm break-all">
            {start.setup.secret}
          </code>
        </div>
      </div>
      <BackupCodes codes={start.setup.backupCodes} />
      <form action={confirmAction} aria-label="Code bestätigen" className="flex flex-col gap-4">
        <Field label="2. Code aus der App">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required className="w-40 tracking-widest" />
        </Field>
        <ErrorNote state={confirm} />
        <div>
          <Button type="submit" variant="primary" disabled={confirming}>
            {confirming ? "Prüfen …" : "Bestätigen und einschalten"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function RegenerateCodesForm(props: { action: FormAction<TwoFactorFormState> }) {
  const [state, action, pending] = useActionState(props.action, {});
  if (state.codes) return <BackupCodes codes={state.codes} />;
  return (
    <form action={action} aria-label="Neue Wiederherstellungscodes" className="flex flex-col gap-4">
      <p className="text-sm text-muted">Erzeugt zehn neue Codes. Die bisherigen werden ungültig.</p>
      <PasswordField />
      <ErrorNote state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          Neue Codes erzeugen
        </Button>
      </div>
    </form>
  );
}

export function DisableForm(props: { action: FormAction<TwoFactorFormState> }) {
  const [state, action, pending] = useActionState(props.action, {});
  return (
    <form action={action} aria-label="Zwei-Faktor ausschalten" className="flex flex-col gap-4">
      <PasswordField />
      <ErrorNote state={state} />
      <div>
        <Button type="submit" variant="danger" disabled={pending}>
          Ausschalten
        </Button>
      </div>
    </form>
  );
}

/** Eigenes Passwort ändern (auch der Pflicht-Wechsel nach einem Startpasswort). */
export function PasswordChangeForm({ action, min }: { action: FormAction<PasswordFormState>; min: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label="Passwort ändern" className="flex flex-col gap-4">
      <Field label="Bisheriges Passwort" error={e.current}>
        <Input name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="Neues Passwort" error={e.next} hint={`Mindestens ${min} Zeichen. Gut sind mehrere Wörter, z. B. „Tafel Kreide Pause“.`}>
        <Input name="next" type="password" autoComplete="new-password" required minLength={min} />
      </Field>
      <Field label="Neues Passwort wiederholen" error={e.repeat}>
        <Input name="repeat" type="password" autoComplete="new-password" required />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Bitte warten …" : "Passwort ändern"}
        </Button>
      </div>
    </form>
  );
}
