"use client";

import { startTransition, useActionState } from "react";
import { alarmSettingsAction, channelAction, healthSettingsAction, healthTokenAction, rebootAction, releaseUpdateAction, testMailAction, type SystemOrderState } from "@/modules/verwaltung/system-actions";
import { BACKUP_HOURS_MAX, BACKUP_HOURS_MIN, HEALTH_MODE_LABEL, HEALTH_MODES, MAIL_BACKLOG_MAX, MAIL_BACKLOG_MIN, type HealthSettings } from "@/core/system/health-config";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";

function Message({ state }: { state: SystemOrderState }) {
  if (state.error)
    return (
      <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        {state.ok}
      </p>
    );
  return null;
}

/** Freigabe eines Funktions-Updates: sofort oder im nächsten Wartungsfenster (Patches kommen ohne Freigabe). */
export function ReleaseForm({ target }: { target: string }) {
  const [state, action, pending] = useActionState<SystemOrderState, FormData>(releaseUpdateAction, {});
  return (
    <form action={action} aria-label={`SchulOS ${target} freigeben`} className="flex flex-col gap-3">
      <input type="hidden" name="target" value={target} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="wann" value="wartungsfenster" variant="primary" size="sm" disabled={pending}>
          Im Wartungsfenster installieren
        </Button>
        <Button type="submit" name="wann" value="jetzt" variant="secondary" size="sm" disabled={pending}>
          Jetzt installieren
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function ChannelForm({ channel }: { channel: "stabil" | "beta" }) {
  const [state, action, pending] = useActionState<SystemOrderState, FormData>(channelAction, {});
  return (
    <form action={action} aria-label="Update-Kanal" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="kanal" className="text-sm text-muted">
          Kanal
        </label>
        <Select id="kanal" name="kanal" defaultValue={channel} className="w-auto">
          <option value="stabil">stabil – für den Schulbetrieb</option>
          <option value="beta">beta – neue Funktionen früher</option>
        </Select>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Übernehmen
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** Q5-18: Neustart von Hand (Passphrase beim Start) – erst nach Rückfrage, SchulOS ist bis zur Eingabe nicht erreichbar. */
export function RebootForm() {
  const [state, action, pending] = useActionState<SystemOrderState>(rebootAction, {});
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (confirm("Server jetzt sichern und neu starten? SchulOS ist erst wieder erreichbar, wenn jemand an der Konsole die Passphrase eingibt."))
              startTransition(() => action());
          }}
        >
          Jetzt neu starten
        </Button>
      </div>
      <Message state={state} />
    </div>
  );
}

export function TestMailForm() {
  const [state, action, pending] = useActionState<SystemOrderState>(testMailAction, {});
  return (
    <form action={action} aria-label="Testmail" className="flex flex-col gap-2">
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Wird gesendet …" : "Testmail senden"}
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** SEC-14: zusätzliche Empfänger der Alarme (neben SCHULOS_ALARM_TO) und Schwelle für Häufungen fehlgeschlagener Anmeldungen */
export function AlarmSettingsForm({ recipients, threshold }: { recipients: string[]; threshold: number }) {
  const [state, action, pending] = useActionState<SystemOrderState, FormData>(alarmSettingsAction, {});
  return (
    <form action={action} aria-label="Sicherheitsalarme" className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span>Weitere Empfänger (durch Komma getrennt)</span>
        <Input name="empfaenger" defaultValue={recipients.join(", ")} placeholder="it@schule.de, schulleitung@schule.de" />
        <span className="text-xs text-muted">Jede Änderung meldet SchulOS per Mail an die bisherigen und die neuen Empfänger.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Alarm ab so vielen fehlgeschlagenen Anmeldungen je Stunde (alle Konten zusammen)</span>
        <Input name="schwelle" type="number" min={5} max={10000} defaultValue={threshold} className="w-32" />
      </label>
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Speichern
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

/** BM-02/BM-04: Zugang zum Betriebsstatus (/api/health/details) und Schwellen der Warnungen */
export function HealthSettingsForm({ settings }: { settings: HealthSettings }) {
  const [state, action, pending] = useActionState<SystemOrderState, FormData>(healthSettingsAction, {});
  const [tokenState, tokenAction, tokenPending] = useActionState<SystemOrderState, FormData>(healthTokenAction, {});
  return (
    <div className="mt-3 flex flex-col gap-3">
      <form action={action} aria-label="Betriebsstatus einstellen" className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Betriebsstatus für Überwachung (/api/health/details)</span>
          <Select name="modus" defaultValue={settings.mode} className="w-auto">
            {HEALTH_MODES.map((m) => (
              <option key={m} value={m}>
                {HEALTH_MODE_LABEL[m]}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted">Von außerhalb des Schulnetzes bleibt der Pfad gesperrt. „Nur mit Token“: Kopfzeile Authorization: Bearer …</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Mail-Stau melden, wenn die älteste Mail so viele Minuten wartet</span>
          <Input name="mailstau" type="number" min={MAIL_BACKLOG_MIN} max={MAIL_BACKLOG_MAX} defaultValue={settings.mailBacklogMinutes} className="w-32" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Sicherung melden, wenn die letzte gute Sicherung älter ist als so viele Stunden</span>
          <Input name="sicherung" type="number" min={BACKUP_HOURS_MIN} max={BACKUP_HOURS_MAX} defaultValue={settings.backupMaxHours} className="w-32" />
        </label>
        <div>
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            Speichern
          </Button>
        </div>
        <Message state={state} />
      </form>
      <form action={tokenAction} aria-label="Token erneuern" className="flex flex-col gap-2">
        <div>
          <Button type="submit" variant="secondary" size="sm" disabled={tokenPending}>
            Neues Token erzeugen
          </Button>
        </div>
        <Message state={tokenState} />
      </form>
    </div>
  );
}
