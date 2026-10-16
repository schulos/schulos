import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { savePrivacyTextsAction } from "@/core/privacy/actions";
import { legalBasisWarning, PRIVACY_TEXT_FIELDS, readPrivacyTexts, type PrivacyTextKey } from "@/core/privacy/hinweise";
import { getSchoolSettings } from "@/core/settings";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { VorlageHinweis } from "@/ui/vorlage-hinweis";
import { TextsForm } from "./texts-form";

export const metadata: Metadata = { title: "Angaben der Schule" };

/** Freitexte der Schule für Datenschutzhinweise und VVT (Verantwortliche, DSB, Betrieb, Ergänzungen). */
export default async function AngabenPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const [texts, school] = await Promise.all([readPrivacyTexts(await getDb()), getSchoolSettings()]);
  const warning = legalBasisWarning(school.profile.state);
  const fields = (Object.keys(PRIVACY_TEXT_FIELDS) as PrivacyTextKey[]).map((k) => ({ key: k, ...PRIVACY_TEXT_FIELDS[k], value: texts[k] }));
  return (
    <main className="flex flex-col gap-6">
      <Link href="/verwaltung/datenschutz" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Löschkonzept
      </Link>
      <PageHeader
        eyebrow="Datenschutz"
        title="Angaben der Schule"
        actions={
          <span className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/datenschutzhinweise">Datenschutzhinweise ansehen</Link>
            </Button>
            <Button asChild>
              <Link href="/druck/vvt">VVT drucken</Link>
            </Button>
          </span>
        }
      />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Zwecke, Datenarten, Empfänger und Fristen erzeugt SchulOS aus den aktiven Modulen. Hier ergänzt die Schule, wer verantwortlich ist, wer berät und wer
        den Server betreibt.
      </p>
      <VorlageHinweis className="max-w-3xl" />
      {warning && (
        <p role="alert" className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          {warning}
        </p>
      )}
      <Card>
        <TextsForm action={savePrivacyTextsAction} fields={fields} />
      </Card>
    </main>
  );
}
