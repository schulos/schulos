import { TZ } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import type { ChecklistItem } from "./katalog";
import { ANTRAG_STATUS_LABELS } from "./labels";
import { slotText } from "./mails";
import type { VorgangView } from "./public";

const dateOnly = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: TZ });

/**
 * Stand eines Antrags für die Eltern (Vorgangslink P4-34/35 bzw. Elternkonto P4-34b): Nummer, Stand, Termin, Unterlagen –
 * keine Namen, keine Anschrift.
 */
export function VorgangDetails({ v, icsHref, documents, children }: { v: VorgangView; icsHref: string | null; documents: ChecklistItem[]; children?: React.ReactNode }) {
  return (
    <>
      <Card aria-label="Stand">
        <CardHeader title="Stand" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Vorgangsnummer</dt>
          <dd data-testid="vorgangsnummer" className="font-medium tabular-nums">
            {v.number}
          </dd>
          <dt className="text-muted">Stand</dt>
          <dd>
            <Badge tone={v.status === "zurueckgezogen" ? "neutral" : "soft"}>{ANTRAG_STATUS_LABELS[v.status]}</Badge>
          </dd>
          <dt className="text-muted">Gesprächstermin</dt>
          <dd data-testid="termin">
            {v.slot ? (
              <span className="flex flex-col gap-1">
                <span>{slotText(v.slot, v.slot.room)}</span>
                {icsHref && v.open && (
                  <a href={icsHref} className="w-fit text-accent-ink underline underline-offset-2" download>
                    In den Kalender übernehmen (.ics)
                  </a>
                )}
              </span>
            ) : (
              "noch kein Termin"
            )}
          </dd>
          {v.validUntil && (
            <>
              <dt className="text-muted">Link gültig bis</dt>
              <dd>{dateOnly.format(v.validUntil)}</dd>
            </>
          )}
        </dl>
      </Card>
      {children}
      <Card aria-label="Unterlagen">
        <CardHeader title="Zum Gespräch mitbringen" />
        <ul className="list-disc pl-5 text-sm">
          {documents.map((c) => (
            <li key={c.key}>{c.label}</li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted">Verbindlich wird die Anmeldung erst im persönlichen Gespräch.</p>
      </Card>
    </>
  );
}
