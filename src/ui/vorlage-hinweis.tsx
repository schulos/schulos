import { TEMPLATE_LABEL, TEMPLATE_NOTE } from "@/core/privacy/hinweise";

/**
 * DS-14: Kennzeichnung der aus den Manifesten erzeugten Datenschutz-Texte (Datenschutzhinweise, VVT) als Vorlage. Sachlich,
 * ohne Warnfarbe – es ist ein Arbeitsstand der Schule, kein Fehler. Erscheint auch im Druck.
 */
export function VorlageHinweis({ className = "" }: { className?: string }) {
  return (
    <section
      aria-label="Vorlage"
      data-testid="vorlage-hinweis"
      className={`rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm break-inside-avoid print:bg-transparent ${className}`}
    >
      <p className="font-semibold">{TEMPLATE_LABEL}</p>
      <p className="text-muted print:text-ink">{TEMPLATE_NOTE}</p>
    </section>
  );
}
