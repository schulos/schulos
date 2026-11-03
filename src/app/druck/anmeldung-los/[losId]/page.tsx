import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auditRead } from "@/core/audit";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { LOS_STATUS_LABELS } from "@/modules/anmeldung/labels";
import { getLot } from "@/modules/anmeldung/los";
import { canView } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Losprotokoll" };
export const dynamic = "force-dynamic";

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const dt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/**
 * LO-03: Protokoll eines Losverfahrens für die Akte. Gespeichert sind nur Nummern, Seed und Zeug:innen-Funktionen – die Namen
 * kommen hier aus den noch vorhandenen Anträgen dazu. Lesen mit `anmeldung.view`, sonst 404; der Druck steht im Audit-Log.
 */
export default async function LosprotokollPage({ params }: { params: Promise<{ losId: string }> }) {
  await requireModulePage("anmeldung");
  const { perms } = await requireUser();
  if (!canView(perms)) notFound();
  const { losId } = await params;
  const db = await getDb();
  const detail = await getLot(db, perms, decodeURIComponent(losId));
  if (!detail) notFound();
  const { lot, rows, verify, verfahrenName } = detail;
  await auditRead(db, perms.userId, "lesen.anmeldung.los", lot.id, { verfahren: lot.verfahrenId, lauf: lot.seq });
  const drawn = lot.order !== null;
  const facts: [string, string][] = [
    ["Stand", LOS_STATUS_LABELS[lot.status]],
    ["Plätze", `${lot.places} von ${lot.participants.length} Anträgen`],
    ["Vorbereitet", dt.format(lot.preparedAt)],
    ["Prüfwert (SHA-256 des Seeds)", lot.seedHash],
    ["Seed", lot.seed ?? "noch nicht aufgedeckt (wird beim Ziehen aufgedeckt)"],
    ...(lot.drawnAt ? ([["Gezogen", dt.format(lot.drawnAt)]] as [string, string][]) : []),
    ["Zeug:innen (Funktionen)", lot.witnesses ?? "–"],
    ...(lot.appliedAt ? ([["Ergebnis übernommen", dt.format(lot.appliedAt)]] as [string, string][]) : []),
    ...(lot.discardedAt ? ([["Verworfen", dt.format(lot.discardedAt)]] as [string, string][]) : []),
    ...(lot.reason ? ([[lot.replacesId ? "Begründung für das Neulosen" : "Begründung", lot.reason]] as [string, string][]) : []),
    ...(verify ? ([["Nachgerechnet", verify.hashOk && verify.orderOk ? "Seed passt zum Prüfwert, Reihenfolge stimmt" : "Abweichung"]] as [string, string][]) : []),
  ];
  const cell = "[&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-medium";
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/verwaltung/anmeldung/${lot.verfahrenId}/los/${lot.id}`}>Zurück zum Losverfahren</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow={verfahrenName} title={`Losprotokoll – Lauf ${lot.seq}`} subtitle="Auswahl bei Anmeldeüberhang" stamp={`gedruckt am ${stamp.format(new Date())}`} />
        <table className={`w-full border-collapse text-left text-sm ${cell} [&_th]:w-[60mm]`}>
          <tbody>
            {facts.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="break-all whitespace-pre-line">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section aria-label="Teilnehmende" className="flex flex-col gap-2">
          <h2 className="font-semibold">{drawn ? "Ergebnis (Rangliste)" : "Teilnehmende"}</h2>
          <table className={`w-full border-collapse text-left text-sm ${cell}`}>
            <thead>
              <tr>
                {drawn && <th scope="col">Rang</th>}
                <th scope="col">Vorgangsnummer</th>
                <th scope="col">Kind</th>
                {drawn && <th scope="col">Ergebnis</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.number}>
                  {drawn && <td className="tabular-nums">{r.outcome?.rank}</td>}
                  <td className="tabular-nums">{r.number}</td>
                  <td>{r.child ?? "(Antrag gelöscht)"}</td>
                  {drawn && <td>{r.outcome?.outcome === "aufgenommen" ? "Aufnahme" : `Warteliste, Rang ${r.outcome?.waitlistRank}`}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section aria-label="Verfahren" className="flex flex-col gap-1 text-xs">
          <h2 className="text-sm font-semibold">Verfahren</h2>
          <p>
            Die Losgruppe hat die Schulleitung aus Anträgen gebildet, die nach den übrigen Aufnahmekriterien gleichrangig sind; SchulOS bewertet keine
            Kriterien. Der Seed (128 Bit Zufall) stand beim Vorbereiten fest, angezeigt wurde vor dem Ziehen nur sein Prüfwert. Nachrechnen: SHA-256 des
            Seeds = Prüfwert; je Vorgangsnummer den Text „Seed:Nummer“ mit FNV-1a (32 Bit) hashen und aufsteigend sortieren (bei Gleichstand nach der
            Nummer) – das ergibt die Rangliste. Rang 1 bis {lot.places} werden aufgenommen, die übrigen kommen in dieser Reihenfolge auf die Warteliste.
          </p>
        </section>
        <div className="mt-10 grid grid-cols-2 gap-10 text-xs">
          <p className="border-t border-ink pt-1">Ort, Datum, Unterschrift Schulleitung</p>
          <p className="border-t border-ink pt-1">Unterschrift Zeug:in</p>
        </div>
      </main>
    </div>
  );
}
