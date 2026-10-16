import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { readSchoolSettings } from "@/core/settings";
import { TZ } from "@/core/time";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { slotText } from "@/modules/anmeldung/mails";
import { getAntrag } from "@/modules/anmeldung/sekretariat";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Anmeldebogen" };
export const dynamic = "force-dynamic";

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** Anmeldebogen fürs Gespräch bzw. zur Unterschrift (P4-36) – Lesezugriff protokolliert. */
export default async function AnmeldebogenPage({ params }: { params: Promise<{ antragId: string }> }) {
  await requireModulePage("anmeldung");
  const { perms } = await requireUser();
  const { antragId } = await params;
  const db = await getDb();
  const r = await getAntrag(db, perms, decodeURIComponent(antragId)).catch(() => null);
  if (!r) notFound();
  const a = r.antrag;
  const katalog = anmeldungKatalog((await readSchoolSettings(db)).profile.state);
  const rows: [string, string | null][] = [
    ["Vorname, Name des Kindes", `${a.childFirstName} ${a.childLastName}`],
    ["Geburtsdatum", a.childBirthDate.split("-").reverse().join(".")],
    ["Grundschule", a.primarySchool],
    ["Geschwisterkind an der Schule", a.sibling ? `ja${a.siblingNote ? ` – ${a.siblingNote}` : ""}` : "nein"],
    ["Zweitwunsch", a.secondChoiceSchool],
    ["Elternteil", a.parent1Name],
    ["E-Mail / Telefon", [a.parent1Email, a.parent1Phone].filter(Boolean).join(" / ")],
    ["Anschrift", [a.addressStreet, [a.addressZip, a.addressCity].filter(Boolean).join(" ")].filter(Boolean).join(", ")],
    ["Zweiter Elternteil", [a.parent2Name, a.parent2Email].filter(Boolean).join(" / ") || null],
    ["Hinweise für das Gespräch", a.hints],
    ["Gesprächstermin", r.slot ? slotText(r.slot, r.slot.room) : null],
  ];
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/verwaltung/anmeldung/${a.verfahrenId}/antrag/${a.id}`}>Zurück zum Antrag</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow={r.verfahrenName} title="Anmeldebogen" subtitle={`Vorgangsnummer ${r.number}`} stamp={`gedruckt am ${stamp.format(new Date())}`} />
        <table className="w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1.5 [&_th]:w-[60mm] [&_th]:font-medium">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="whitespace-pre-line">{v || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section aria-label="Unterlagen" className="flex flex-col gap-1 text-sm">
          <h2 className="font-semibold">Im Original vorgelegt</h2>
          {katalog.checklist.map((c) => (
            <p key={c.key}>
              {r.checklist[c.key] ? "☒" : "☐"} {c.label}
            </p>
          ))}
        </section>
        <p className="text-sm">Die Angaben sind richtig. Verbindlich wird die Anmeldung mit diesem Gespräch; über die Aufnahme entscheidet die Schulleitung.</p>
        <div className="mt-10 grid grid-cols-2 gap-10 text-xs">
          <p className="border-t border-ink pt-1">Ort, Datum, Unterschrift Erziehungsberechtigte</p>
          <p className="border-t border-ink pt-1">Unterschrift Schule</p>
        </div>
      </main>
    </div>
  );
}
