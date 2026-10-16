import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/core/db/client";
import { A11Y_STATUS_LABEL, KNOWN_BARRIERS, defaultEnforcement, legalBasis, missingA11yFields, readA11yStatement } from "@/core/school/barrierefreiheit";
import { readImpressum } from "@/core/school/impressum";
import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Erklärung zur Barrierefreiheit" };
export const dynamic = "force-dynamic";

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });
const fmtDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((p) => (
        <p key={p} className="whitespace-pre-line">
          {p}
        </p>
      ))}
    </>
  );
}

/**
 * Erklärung zur Barrierefreiheit (A11Y-02) – öffentlich wie Impressum und Datenschutzhinweise. Aufbau nach dem EU-Muster
 * (Durchführungsbeschluss (EU) 2018/1523); Angaben der Schule unter Verwaltung → Schule, Kontakt notfalls aus dem Impressum,
 * Durchsetzungsverfahren nach Bundesland (Vorgabe NRW). Bekannte Einschränkungen von SchulOS kommen aus dem Code.
 */
export default async function BarrierefreiheitPage() {
  const db = await getDb();
  const [s, imp, school] = await Promise.all([readA11yStatement(db), readImpressum(db), getSchoolSettings()]);
  const email = s.contactEmail || imp.fields.email;
  const phone = s.contactPhone || imp.fields.phone;
  const draft = missingA11yFields({ ...s, contactEmail: email, contactPhone: phone }).length > 0;
  const extra = s.extraBarriers
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface px-4 py-8 text-ink print:p-0">
      <nav aria-label="Optionen" className="mx-auto mb-6 flex max-w-3xl flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">Zu SchulOS</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/impressum">Impressum</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/datenschutzhinweise">Datenschutzhinweise</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 leading-relaxed">
        <header>
          <SchoolLogo logos={school.logos} name={school.name} className="mb-3 h-12 max-w-full" />
          <p className="text-sm text-muted">{school.name}</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Erklärung zur Barrierefreiheit</h1>
        </header>
        {draft && (
          <p role="note" data-testid="barrierefreiheit-vorlage" className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm">
            <strong>Vorlage:</strong> Die Schule hat ihre Angaben (Kontakt, Datum der Überprüfung) noch nicht vollständig eingetragen.
          </p>
        )}
        <p>
          {school.name} ist bemüht, die Schulplattform SchulOS im Einklang mit {legalBasis(school.profile.state)} barrierefrei zugänglich zu machen. Diese
          Erklärung gilt für SchulOS unter dieser Adresse, einschließlich der öffentlichen Seiten (Anmeldung, Schulanmeldung, Impressum, Datenschutzhinweise).
        </p>

        <section aria-labelledby="stand" className="flex flex-col gap-2">
          <h2 id="stand" className="font-display text-lg font-bold">
            Stand der Vereinbarkeit mit den Anforderungen
          </h2>
          <p data-testid="barrierefreiheit-stand">
            SchulOS ist mit den Anforderungen der Barrierefreiheit (WCAG 2.1, Konformitätsstufe AA, bzw. EN 301 549){" "}
            <strong>{A11Y_STATUS_LABEL[s.status]}</strong>
            {s.status === "vollstaendig" ? "." : ". Die nachstehend aufgeführten Inhalte sind nicht oder nur eingeschränkt barrierefrei."}
          </p>
        </section>

        {s.status !== "vollstaendig" && (
          <section aria-labelledby="nicht-barrierefrei" className="flex flex-col gap-2">
            <h2 id="nicht-barrierefrei" className="font-display text-lg font-bold">
              Nicht barrierefreie Inhalte
            </h2>
            <ul className="list-disc pl-5">
              {[...KNOWN_BARRIERS, ...extra].map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <p className="text-sm text-muted">
              Wo Inhalte nicht barrierefrei sind, stellt die Schule sie auf Anfrage in einer zugänglichen Form bereit (z. B. als Text oder im Gespräch).
            </p>
          </section>
        )}

        <section aria-labelledby="erstellung" className="flex flex-col gap-2">
          <h2 id="erstellung" className="font-display text-lg font-bold">
            Erstellung dieser Erklärung
          </h2>
          <p>
            {s.reviewedOn ? <>Diese Erklärung wurde am {fmtDay(s.reviewedOn)} erstellt bzw. zuletzt überprüft. </> : null}
            Grundlage ist eine Selbstbewertung der Schule. SchulOS wird bei jeder Änderung automatisiert auf die Anforderungen der WCAG 2.1/2.2 (Stufe AA)
            geprüft und auf den Kernseiten aller Rollen mit der Tastatur getestet.
          </p>
        </section>

        <section aria-labelledby="feedback" className="flex flex-col gap-2">
          <h2 id="feedback" className="font-display text-lg font-bold">
            Feedback und Kontaktangaben
          </h2>
          <p>
            Sind Ihnen Mängel bei der Barrierefreiheit aufgefallen, oder benötigen Sie Informationen in einer zugänglichen Form? Dann wenden Sie sich bitte an{" "}
            {s.contactName || school.name}:
          </p>
          {email || phone ? (
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]" data-testid="barrierefreiheit-kontakt">
              {email && (
                <div className="contents">
                  <dt className="font-medium">E-Mail</dt>
                  <dd>
                    <a href={`mailto:${email}`} className="text-accent-ink underline underline-offset-2">
                      {email}
                    </a>
                  </dd>
                </div>
              )}
              {phone && (
                <div className="contents">
                  <dt className="font-medium">Telefon</dt>
                  <dd>{phone}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-muted italic">Die Schule hat noch keine Kontaktangaben eingetragen.</p>
          )}
        </section>

        <section aria-labelledby="durchsetzung" className="flex flex-col gap-2">
          <h2 id="durchsetzung" className="font-display text-lg font-bold">
            Durchsetzungsverfahren
          </h2>
          <Paragraphs text={s.enforcement || defaultEnforcement(school.profile.state)} />
        </section>
      </main>
    </div>
  );
}
