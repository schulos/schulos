import Link from "next/link";
import { getDb } from "@/core/db/client";
import { readPrivacyTexts } from "@/core/privacy/hinweise";
import { readSchoolSettings } from "@/core/settings";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import manifest from "@/modules/anmeldung/manifest";
import { CONFIRM_HOURS } from "@/modules/anmeldung/public";

/**
 * Datenschutzhinweis nach Art. 13 DSGVO direkt am Formular (P4-34): aus der Verarbeitungstätigkeit des Moduls und den
 * Angaben der Schule erzeugt; die vollständigen Hinweise stehen unter /datenschutzhinweise.
 */
export async function PrivacyNotice() {
  const db = await getDb();
  const [texts, school] = await Promise.all([readPrivacyTexts(db), readSchoolSettings(db)]);
  const p = manifest.processing;
  return (
    <section aria-label="Datenschutzhinweis" className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-4 text-sm">
      <h3 className="font-semibold">Datenschutzhinweis zur Schulanmeldung</h3>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Verantwortlich</dt>
        <dd className="whitespace-pre-line">{texts.controller || school.name}</dd>
        {texts.dpo && (
          <>
            <dt className="text-muted">Datenschutzbeauftragte:r</dt>
            <dd className="whitespace-pre-line">{texts.dpo}</dd>
          </>
        )}
        <dt className="text-muted">Zweck</dt>
        <dd>{p.purpose}.</dd>
        <dt className="text-muted">Rechtsgrundlage</dt>
        <dd>{anmeldungKatalog(school.profile.state).legalBasis}</dd>
        <dt className="text-muted">Wer die Daten sieht</dt>
        <dd>{p.recipients.join("; ")}. Keine Weitergabe an Dritte, keine Werbung, kein Tracking.</dd>
        <dt className="text-muted">Speicherdauer</dt>
        <dd>
          Ohne Bestätigung der E-Mail-Adresse löschen wir alles nach {CONFIRM_HOURS} Stunden. Zurückgezogene Anmeldungen löschen wir nach 90 Tagen,
          abgelehnte nach Abschluss des Verfahrens und Ablauf der Widerspruchsfrist; bei Aufnahme gehen die Daten in die Schülerakte über.
        </dd>
        <dt className="text-muted">Ihre Rechte</dt>
        <dd>Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch und Beschwerde bei der Aufsichtsbehörde – wenden Sie sich an das Sekretariat.</dd>
      </dl>
      <p>
        Wir fragen nur, was für den Termin und das Gespräch nötig ist – keine Angaben zu Religion, Gesundheit oder Förderbedarf.{" "}
        <Link href="/datenschutzhinweise" className="underline underline-offset-2" target="_blank">
          Vollständige Datenschutzhinweise
        </Link>
      </p>
    </section>
  );
}
