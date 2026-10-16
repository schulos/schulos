import type { Metadata } from "next";
import Link from "next/link";
import { pendingEmailChange } from "@/core/auth/email";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { EmailConfirmForm } from "../forms";

export const metadata: Metadata = { title: "E-Mail-Adresse bestätigen" };
export const dynamic = "force-dynamic";

/**
 * Bestätigungslink (Q5-04). Nur angemeldet und nur für das eigene Konto; bestätigt wird per Knopf (POST), nicht schon
 * beim Öffnen – Link-Vorschauen von Mailprogrammen lösen so nichts aus.
 */
export default async function EmailConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { user } = await requireUser();
  const { token } = await params;
  const pending = await pendingEmailChange(await getDb(), user.id, decodeURIComponent(token));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="E-Mail-Adresse bestätigen" />
      <Card className="max-w-2xl">
        <CardHeader title={pending ? "Neue Adresse" : "Link ungültig"} />
        {pending ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <strong>{pending.email}</strong> wird die E-Mail-Adresse Ihres Kontos.
            </p>
            <EmailConfirmForm token={decodeURIComponent(token)} />
          </div>
        ) : (
          <p className="text-sm">
            Der Link ist ungültig oder abgelaufen – oder er gehört zu einem anderen Konto.{" "}
            <Link href="/konto/email" className="text-accent-ink underline underline-offset-2">
              Adresse noch einmal eintragen
            </Link>
          </p>
        )}
      </Card>
    </main>
  );
}
