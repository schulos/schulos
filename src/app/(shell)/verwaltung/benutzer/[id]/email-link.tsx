"use client";

import { MailCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { sendEmailConfirmationAction, type FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";

/**
 * Q5-24: „Bestätigungslink senden“ für die eingetragene, unbestätigte Adresse. Die Person bestätigt angemeldet über den
 * Link (wie bei der Selbstbedienung); ohne SMTP nur ein Hinweis.
 */
export function EmailLinkButton({ id, mailOn }: { id: string; mailOn: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FormState & { sentTo?: string }>({});
  if (!mailOn)
    return <p className="text-sm text-muted">Bestätigungslink senden geht erst mit eingerichtetem E-Mail-Versand (Verwaltung → System).</p>;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" size="sm" disabled={pending} onClick={() => start(async () => setResult(await sendEmailConfirmationAction(id)))}>
          <MailCheck aria-hidden /> {pending ? "Wird gesendet …" : "Bestätigungslink senden"}
        </Button>
      </div>
      {result.ok && (
        <p role="status" className="text-sm text-success">
          Link an {result.sentTo} gesendet – gültig 24 Stunden, die Person muss dafür angemeldet sein.
        </p>
      )}
      {result.error && (
        <p role="alert" className="text-sm text-danger">
          {result.error}
        </p>
      )}
    </div>
  );
}
