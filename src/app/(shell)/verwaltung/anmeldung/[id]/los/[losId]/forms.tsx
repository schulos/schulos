"use client";

import { useActionState } from "react";
import { applyLotAction, discardLotAction, drawLotAction, type ApplyLotState } from "@/modules/anmeldung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input, Textarea } from "@schulos/ui/field";

function Alert({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

/** LO-02: Los ziehen – deckt den Seed auf; Zeug:innen nur als Funktionen. */
export function DrawLotForm({ verfahrenId, lotId }: { verfahrenId: string; lotId: string }) {
  const [state, action, pending] = useActionState(drawLotAction.bind(null, verfahrenId, lotId), {});
  return (
    <form action={action} aria-label="Los ziehen" className="flex flex-col gap-3">
      <Field label="Anwesende Zeug:innen (nur Funktionen, optional)" hint="z. B. „Stellv. Schulleitung, Elternvertretung“ – bitte keine Namen" error={state.fieldErrors?.witnesses}>
        <Input name="witnesses" maxLength={300} defaultValue={state.values?.witnesses ?? ""} />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Los ziehen
        </Button>
      </div>
      <Alert error={state.error} />
    </form>
  );
}

/** LO-02: Ergebnis übernehmen – Rang 1…N aufgenommen, Rest Warteliste mit Rang. */
export function ApplyLotForm({ verfahrenId, lotId, places, total }: { verfahrenId: string; lotId: string; places: number; total: number }) {
  const [state, action, pending] = useActionState<ApplyLotState>(() => applyLotAction(verfahrenId, lotId), {});
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        Übernommen: {state.admitted} aufgenommen, {state.waitlisted} auf der Warteliste
        {state.mails ? ` – ${state.mails === 1 ? "1 Mail" : `${state.mails} Mails`} „Bescheid folgt per Post“ verschickt` : ""}.
      </p>
    );
  return (
    <form action={action} aria-label="Ergebnis übernehmen" className="flex flex-col gap-3">
      <p className="text-sm">
        Rang 1 bis {places} werden aufgenommen, Rang {places + 1} bis {total} kommen mit ihrem Rang auf die Warteliste. Die Eltern bekommen wie bei jeder
        ersten Entscheidung nur die Mail „Bescheid folgt per Post“.
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Ergebnis übernehmen
        </Button>
      </div>
      <Alert error={state.error} />
    </form>
  );
}

/** LO-02: Neu losen bzw. verwerfen. Nach dem Ziehen nur mit Begründung; vorher (Seed noch geheim) nur verwerfen. */
export function DiscardLotForm({ verfahrenId, lotId, drawn }: { verfahrenId: string; lotId: string; drawn: boolean }) {
  const [state, action, pending] = useActionState(discardLotAction.bind(null, verfahrenId, lotId), {});
  if (state.ok)
    return (
      <p role="status" className="text-sm text-success">
        Lauf verworfen.
      </p>
    );
  return (
    <form action={action} aria-label={drawn ? "Neu losen oder verwerfen" : "Lauf verwerfen"} className="flex flex-col gap-3">
      {drawn && (
        <Field label="Begründung (Pflicht)" hint="Warum wird neu gelost bzw. verworfen? Bitte keine Gesundheitsangaben." error={state.fieldErrors?.reason}>
          <Textarea name="reason" rows={2} maxLength={500} required defaultValue={state.values?.reason ?? ""} />
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        {drawn && (
          <Button type="submit" name="op" value="neu" size="sm" disabled={pending}>
            Neu losen
          </Button>
        )}
        <Button type="submit" name="op" value="verwerfen" size="sm" variant={drawn ? "danger" : "secondary"} disabled={pending}>
          Lauf verwerfen
        </Button>
      </div>
      <Alert error={state.error} />
    </form>
  );
}
