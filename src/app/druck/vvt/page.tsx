import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { activeProcessingRecords, legalBasisWarning, missingTexts, PRIVACY_TEXT_FIELDS, readPrivacyTexts } from "@/core/privacy/hinweise";
import { getSchoolSettings } from "@/core/settings";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";
import { VorlageHinweis } from "@/ui/vorlage-hinweis";

export const metadata: Metadata = { title: "Verzeichnis der Verarbeitungstätigkeiten" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });
const cell = "border border-border-strong px-2 py-1 align-top";

/** VVT nach Art. 30 DSGVO: je aktivem Modul eine Verarbeitungstätigkeit, druckbar (Schulleitung/Admin). */
export default async function VvtPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const db = await getDb();
  const [records, texts, school] = await Promise.all([activeProcessingRecords(db), readPrivacyTexts(db), getSchoolSettings()]);
  const missing = missingTexts(texts);
  const warning = legalBasisWarning(school.profile.state);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/verwaltung/datenschutz">Zurück zum Datenschutz</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/verwaltung/datenschutz/angaben">Angaben der Schule bearbeiten</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5 text-sm">
        <DruckKopf
          title="Verzeichnis der Verarbeitungstätigkeiten (Art. 30 DSGVO)"
          subtitle="Plattform SchulOS · erzeugt aus den aktiven Modulen"
          stamp={`Stand ${dayFmt.format(new Date())}`}
        />
        <VorlageHinweis />
        {warning && (
          <p role="alert" className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
            {warning}
          </p>
        )}
        {missing.length > 0 && (
          <p role="alert" className="rounded-lg bg-warn-soft px-3 py-2 text-warn print:border print:border-border-strong">
            Noch offen: {missing.map((k) => PRIVACY_TEXT_FIELDS[k].label).join(", ")}.
          </p>
        )}
        <table className="w-full border-collapse">
          <caption className="sr-only">Angaben zum Verantwortlichen</caption>
          <tbody>
            {(["controller", "dpo", "operator"] as const).map((k) => (
              <tr key={k}>
                <th scope="row" className={`${cell} w-48 text-left`}>
                  {PRIVACY_TEXT_FIELDS[k].label}
                </th>
                <td className={`${cell} whitespace-pre-line`}>{texts[k] || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {records.map((r, i) => (
          <section key={r.id} aria-labelledby={`v-${r.id}`} className="flex break-inside-avoid flex-col gap-2">
            <h2 id={`v-${r.id}`} className="font-display text-lg font-bold">
              {i + 1}. {r.title}
            </h2>
            <table className="w-full border-collapse">
              <caption className="sr-only">{r.title}</caption>
              <tbody>
                {[
                  ["Zweck", r.purpose],
                  ["Rechtsgrundlage", r.legalBasis],
                  ["Betroffene", r.subjects.join(", ")],
                  ["Empfänger (intern)", r.recipients.join("; ")],
                  ["Drittlandübermittlung", "keine"],
                  ["Technische und organisatorische Maßnahmen", "siehe Sicherheitskonzept SchulOS (DATENSCHUTZ.md §6) und TOM der Schule"],
                  ...(r.note ? [["Hinweis", r.note]] : []),
                ].map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row" className={`${cell} w-48 text-left`}>
                      {k}
                    </th>
                    <td className={cell}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.dataTypes.length > 0 && (
              <table className="w-full border-collapse">
                <caption className="sr-only">Datenarten {r.title}</caption>
                <thead>
                  <tr>
                    <th className={`${cell} text-left`}>Datenart</th>
                    <th className={`${cell} text-left`}>Datenkategorien</th>
                    <th className={`${cell} text-left`}>Löschfrist</th>
                  </tr>
                </thead>
                <tbody>
                  {r.dataTypes.map((d) => (
                    <tr key={`${d.purpose}-${d.scope ?? ""}`}>
                      <td className={cell}>
                        {d.purpose}
                        {d.scope && ` (${d.scope})`}
                      </td>
                      <td className={cell}>{d.categories.join(", ")}</td>
                      <td className={cell}>{d.retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </main>
    </div>
  );
}
