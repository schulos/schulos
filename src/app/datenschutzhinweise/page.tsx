import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/core/db/client";
import { activeProcessingRecords, legalBasisWarning, missingTexts, readPrivacyTexts } from "@/core/privacy/hinweise";
import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";
import { VorlageHinweis } from "@/ui/vorlage-hinweis";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Datenschutzhinweise" };
export const dynamic = "force-dynamic";

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });

function Block({ title, text, fallback }: { title: string; text: string; fallback: string }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {text ? <p className="whitespace-pre-line">{text}</p> : <p className="text-muted italic">{fallback}</p>}
    </section>
  );
}

/** Datenschutzhinweise nach Art. 13/14 DSGVO – öffentlich (vor der Anmeldung lesbar), aus den aktiven Modulen erzeugt. */
export default async function DatenschutzhinweisePage() {
  const db = await getDb();
  const [records, texts, school] = await Promise.all([activeProcessingRecords(db), readPrivacyTexts(db), getSchoolSettings()]);
  const warning = legalBasisWarning(school.profile.state);
  // DS-14: solange die Schule ihre Angaben (Verantwortliche, DSB, Betrieb) nicht eingetragen hat, sichtbar als Vorlage
  const draft = missingTexts(texts).length > 0;
  return (
    <div data-theme="light" className="min-h-dvh bg-surface px-4 py-8 text-ink print:p-0">
      <nav aria-label="Optionen" className="mx-auto mb-6 flex max-w-3xl flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">Zurück zu SchulOS</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/barrierefreiheit">Barrierefreiheit</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 leading-relaxed">
        <header>
          <SchoolLogo logos={school.logos} name={school.name} className="mb-3 h-12 max-w-full" />
          <p className="text-sm text-muted">{school.name}</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Datenschutzhinweise für SchulOS</h1>
          <p className="mt-1 text-sm text-muted">Informationen nach Art. 13 und 14 DSGVO · Stand {dayFmt.format(new Date())}</p>
        </header>
        {draft && <VorlageHinweis />}
        {warning && (
          <p role="alert" className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
            {warning}
          </p>
        )}

        <Block title="Verantwortliche Stelle" text={texts.controller} fallback="Die Schule hat ihre Angaben noch nicht eingetragen." />
        <Block title="Datenschutzbeauftragte:r" text={texts.dpo} fallback="Die Schule hat ihre Angaben noch nicht eingetragen." />
        <Block title="Betrieb der Plattform" text={texts.operator} fallback="Die Schule hat ihre Angaben noch nicht eingetragen." />

        <section className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">Wofür SchulOS Daten verarbeitet</h2>
          <p>
            SchulOS wird von der Schule für den Unterricht und die Schulorganisation eingesetzt. Es gibt keine Werbung, kein Tracking und keine Weitergabe an
            Dritte außerhalb der Schule; Schriften und Programme werden vom eigenen Server geladen. Eine Übermittlung in Drittländer findet nicht statt.
          </p>
        </section>

        {records.map((r) => (
          <section key={r.id} aria-labelledby={`p-${r.id}`} className="flex break-inside-avoid flex-col gap-2 rounded-xl border border-border p-4">
            <h3 id={`p-${r.id}`} className="font-semibold">
              {r.title}
            </h3>
            <p>{r.purpose}.</p>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">Rechtsgrundlage</dt>
              <dd>{r.legalBasis}</dd>
              <dt className="text-muted">Betroffen</dt>
              <dd>{r.subjects.join(", ")}</dd>
              <dt className="text-muted">Wer die Daten sieht</dt>
              <dd>{r.recipients.join("; ")}</dd>
            </dl>
            {r.dataTypes.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {r.dataTypes.map((d) => (
                  <li key={`${d.purpose}-${d.scope ?? ""}`}>
                    <span className="font-medium">
                      {d.purpose}
                      {d.scope && ` (${d.scope})`}
                    </span>
                    : {d.categories.join(", ")} – <span className="text-muted">Löschung: {d.retention}</span>
                  </li>
                ))}
              </ul>
            )}
            {r.note && <p className="text-sm text-muted">{r.note}</p>}
          </section>
        ))}

        <section className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">Ihre Rechte</h2>
          <ul className="list-disc pl-5">
            <li>Auskunft über die gespeicherten Daten (Art. 15) – die Schule stellt sie auf Antrag als Datei zusammen</li>
            <li>Berichtigung (Art. 16), Löschung (Art. 17) und Einschränkung der Verarbeitung (Art. 18), soweit keine Aufbewahrungspflicht entgegensteht</li>
            <li>Herausgabe eigener Dateien und Abgaben (Art. 20) – direkt in SchulOS über „Meine Dateien und Abgaben herunterladen“</li>
            <li>Widerspruch gegen die Verarbeitung aus Gründen, die sich aus Ihrer besonderen Situation ergeben (Art. 21)</li>
            <li>Beschwerde bei der Aufsichtsbehörde (Art. 77){texts.authority && <>: {texts.authority}</>}</li>
          </ul>
          <p className="text-sm text-muted">
            Gelöschte Daten verschwinden spätestens nach etwa drei Monaten auch aus den Sicherungskopien.
          </p>
        </section>

        {texts.extra && <Block title="Ergänzungen der Schule" text={texts.extra} fallback="" />}
        <p className="text-sm text-muted" data-testid="vorlage-fussnote">
          Diese Hinweise erstellt die Schule mit einer Vorlage aus SchulOS. Verantwortlich für die Verarbeitung und für diese Hinweise ist die oben
          genannte verantwortliche Stelle.
        </p>
      </main>
    </div>
  );
}
