import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { CONFIRM_TEXT, readSetup, SETUP_STATUSES } from "@/core/privacy/einrichtung";
import { getSchoolSettings } from "@/core/settings";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";
import { VorlageHinweis } from "@/ui/vorlage-hinweis";

export const metadata: Metadata = { title: "Datenschutz-Konfiguration" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" });
const cell = "border border-border-strong px-2 py-1 align-top";

/** DS-12: Nachweis der Datenschutz-Einrichtung zum Drucken bzw. als PDF für die DSB. */
export default async function DatenschutzEinrichtungDruck() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const [s, school] = await Promise.all([readSetup(await getDb()), getSchoolSettings()]);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/verwaltung/datenschutz/einrichtung">Zurück zur Einrichtung</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5 text-sm">
        <DruckKopf title={`Datenschutz-Konfiguration ${school.name}`} subtitle="Nachweis aus SchulOS für die Datenschutzbeauftragte bzw. den Datenschutzbeauftragten" stamp={`Stand ${dayFmt.format(new Date())}`} />
        <VorlageHinweis />
        <p className={s.done ? "" : "rounded-lg bg-warn-soft px-3 py-2 text-warn print:border print:border-border-strong"}>
          {s.done ? "Einrichtung abgeschlossen." : `Einrichtung noch nicht abgeschlossen (${s.open} offen).`}
        </p>
        <section className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">1. Bestätigung der Schule</h2>
          <p>{CONFIRM_TEXT}</p>
          <p>
            {s.confirmed ? `Bestätigt am ${dayFmt.format(new Date(s.confirmedAt!))}.` : "Noch nicht bestätigt."}
            {s.confirmedDpo && <span className="block whitespace-pre-line">Datenschutzbeauftragte:r: {s.confirmedDpo}</span>}
          </p>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">2. Punkte der DSB-Checkliste</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${cell} text-left`}>Punkt</th>
                <th className={`${cell} text-left`}>Vorgabe / Einstellungen</th>
                <th className={`${cell} text-left`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {s.topics.map((t) => (
                <tr key={t.id} className="break-inside-avoid">
                  <td className={cell}>
                    §{t.nr} {t.title}
                  </td>
                  <td className={cell}>
                    {t.vorgabe}
                    {t.settingsState.map((x) => (
                      <span key={x.key} className="block">
                        {x.label}: {x.valueLabel}
                        {x.changed ? ` (Vorgabe: ${x.defaultLabel})` : " (Vorgabe)"}
                        {!x.moduleEnabled && " – Modul aus"}
                      </span>
                    ))}
                  </td>
                  <td className={cell}>
                    {t.stale ? "seit der Prüfung geändert" : t.status ? SETUP_STATUSES[t.status] : "offen"}
                    {t.checkedAt && <span className="block">am {dayFmt.format(new Date(t.checkedAt))}</span>}
                    {t.note && <span className="block whitespace-pre-line">{t.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="font-display text-lg font-bold">3. Löschfristen</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${cell} text-left`}>Bereich</th>
                <th className={`${cell} text-left`}>Datenart</th>
                <th className={`${cell} text-left`}>Klasse</th>
                <th className={`${cell} text-left`}>Frist</th>
              </tr>
            </thead>
            <tbody>
              {s.retention.map((r) => (
                <tr key={`${r.table}-${r.scope ?? ""}`} className="break-inside-avoid">
                  <td className={cell}>{r.ownerName}</td>
                  <td className={cell}>
                    {r.purpose}
                    {r.scope && ` (${r.scope})`}
                  </td>
                  <td className={cell}>{r.classId ?? "–"}</td>
                  <td className={cell}>
                    {r.rule}
                    {r.setting && " · einstellbar"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
