// DS-18: Hinweis nach Art. 13 DSGVO direkt am Melde- bzw. Beurlaubungsformular (Rechtsgrundlage, Aufbewahrung, wer den
// Grund sieht, keine Atteste über Messenger/Dateien). Inhalt wie DATENSCHUTZ.md §5 und Manifest „abwesenheiten“.
import Link from "next/link";

/**
 * Wer den Grund einer Krankmeldung bzw. Beurlaubung sieht (DATENSCHUTZ.md §5, DSB-Checkliste §1). DS-20: Admin-Konten sehen den
 * Grund einer Krankmeldung nicht mehr (nur Zeitraum und Stand); Beurlaubungsgründe (ohne Gesundheitsbezug) weiterhin.
 */
export const REASON_VISIBLE_TO = {
  meldung: [
    "die Klassenleitung",
    "Personen mit dem Recht „Alle Abwesenheiten bearbeiten“ (z. B. Schulleitung)",
    "alle verknüpften Eltern minderjähriger Kinder bzw. die eigenständige (volljährige) Schülerin, der Schüler selbst",
    "bei einer telefonischen Meldung das Sekretariat, das sie aufnimmt",
  ],
  beurlaubung: [
    "die Klassenleitung",
    "die Schulleitung (entscheidet über längere Beurlaubungen) und Personen mit dem Recht „Alle Abwesenheiten bearbeiten“",
    "alle verknüpften Eltern minderjähriger Kinder bzw. die eigenständige (volljährige) Schülerin, der Schüler selbst",
    "Admin-Konten (technische Betreuung)",
  ],
} as const;

/** DS-16: Gilt die digitale Meldung nicht als schriftliche Entschuldigung, bitte zusätzlich schriftlich entschuldigen. */
export function WrittenExcuseHint({ self = false }: { self?: boolean }) {
  return (
    <p role="note" className="rounded-xl bg-warn-soft px-3 py-2 text-sm">
      {self
        ? "Die Meldung hier ist eine Benachrichtigung – bitte entschuldige dich zusätzlich schriftlich bei deiner Klassenleitung."
        : "Die Meldung hier ist eine Benachrichtigung – bitte entschuldigen Sie das Fehlen zusätzlich schriftlich bei der Klassenleitung."}
    </p>
  );
}

export function AbsencePrivacyNote({ kind, self = false, archived = true }: { kind: "meldung" | "beurlaubung"; self?: boolean; archived?: boolean }) {
  const you = self ? "deine" : "Ihre";
  return (
    <details className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm" aria-label="Hinweise zum Datenschutz">
      <summary className="cursor-pointer font-medium">Hinweise zum Datenschutz</summary>
      <div className="mt-2 flex flex-col gap-2 text-muted">
        {kind === "meldung" ? (
          <p>
            Die Schule verarbeitet {you} Meldung, um Fehlzeiten zu entschuldigen und die Schulpflicht zu überwachen: Art. 6 Abs. 1 lit. e und
            Art. 9 Abs. 2 lit. g DSGVO i. V. m. § 43 Abs. 2, § 120 Abs. 1 und § 122 Abs. 1 Satz 2 SchulG NRW sowie VO-DV I. Gespeichert werden nur
            Zeitraum, Grund („krank“ oder „sonstiger Grund“) und wer gemeldet hat – bis zum Ende des Schuljahres; das Ergebnis
            „entschuldigt“/„nicht entschuldigt“ steht im Klassenbuch.
            {archived &&
              " Die Meldung gilt als schriftliche Entschuldigung und wird deshalb mit der Schülerakte fünf Jahre aufbewahrt (Archivexport, § 9 VO-DV I)."}
          </p>
        ) : (
          <p>
            Die Schule verarbeitet {you} Antrag, um über die Beurlaubung zu entscheiden: Art. 6 Abs. 1 lit. e DSGVO i. V. m. § 43 Abs. 4 und
            § 120 Abs. 1 SchulG NRW sowie VO-DV I. Gespeichert werden Zeitraum, Grund (Auswahl), Antrag und Entscheidung – bis ein Jahr nach
            Ende des Schuljahres; das Ergebnis steht im Klassenbuch.
          </p>
        )}
        <div>
          <p>Den Grund sehen nur:</p>
          <ul className="ml-5 list-disc">
            {REASON_VISIBLE_TO[kind].map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p>
            Fachlehrkräfte sehen nur „entschuldigt“ bzw. „nicht entschuldigt“.
            {kind === "meldung" && " Admin-Konten (technische Betreuung) sehen Zeitraum und Stand, aber nicht den Grund."}
          </p>
        </div>
        <p>
          <strong className="text-ink">Atteste und ärztliche Bescheinigungen bitte nicht über den Messenger oder als Datei schicken</strong> –
          wenn die Schule eines verlangt, auf Papier bei der Klassenleitung abgeben.
        </p>
        <p>
          Weitere Informationen und {you} Rechte (Auskunft, Berichtigung, Löschung) stehen in den{" "}
          <Link href="/datenschutzhinweise" className="underline underline-offset-2">
            Datenschutzhinweisen der Schule
          </Link>
          .
        </p>
      </div>
    </details>
  );
}
