import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { maySelfServeEmail, realEmail } from "@/core/auth/email";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { mailAvailable } from "@/core/mail";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { EmailRemoveForm, EmailRequestForm } from "./forms";

export const metadata: Metadata = { title: "E-Mail-Adresse" };
export const dynamic = "force-dynamic";

/** Eigene E-Mail-Adresse (Q5-04): ändern nur mit Bestätigungslink; Schüler:innen pflegt das Sekretariat. */
export default async function EmailPage({ searchParams }: { searchParams: Promise<{ bestaetigt?: string }> }) {
  const { user } = await requireUser();
  const sp = await searchParams;
  const [u] = await (await getDb()).select({ email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, user.id));
  const email = realEmail(u?.email);
  const self = maySelfServeEmail(user.role);
  const available = mailAvailable();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="E-Mail-Adresse" />
      {sp.bestaetigt && (
        <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
          Die E-Mail-Adresse ist bestätigt.
        </p>
      )}
      <Card aria-label="Aktuelle Adresse" className="max-w-2xl">
        <CardHeader title="Aktuelle Adresse" />
        {email ? (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <strong data-testid="eigene-email">{email}</strong>
              {u?.verified ? <Badge tone="success">bestätigt</Badge> : <Badge tone="warn">nicht bestätigt</Badge>}
            </p>
            {self && <EmailRemoveForm />}
          </div>
        ) : (
          <p className="text-sm text-muted">Keine E-Mail-Adresse eingetragen.</p>
        )}
        <p className="mt-3 text-sm text-muted">
          SchulOS nutzt die Adresse nur für Bestätigungslinks und Hinweise zu Ihrem Konto – nicht für Werbung, nicht für Dritte.
        </p>
      </Card>
      {self ? (
        <Card className="max-w-2xl">
          <CardHeader title={email ? "Adresse ändern oder bestätigen" : "Adresse eintragen"} />
          {!available && (
            <p role="note" className="mb-3 rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
              Der E-Mail-Versand ist an dieser Schule nicht eingerichtet – bitte an das Sekretariat wenden.
            </p>
          )}
          <EmailRequestForm current={email} disabled={!available} />
        </Card>
      ) : (
        <p className="max-w-2xl text-sm text-muted">Bei Schüler:innen trägt das Sekretariat eine E-Mail-Adresse ein, wenn sie gebraucht wird.</p>
      )}
    </main>
  );
}
