import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ, toBerlinDate } from "@/core/time";
import { deskKey } from "@/modules/sitzplan/layout";
import { getPlan } from "@/modules/sitzplan/service";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Sitzplan drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** P5-02: Sitzplan drucken – nur Namen, **nie Fotos** (F5-09); Sichtbarkeit wie die Seite (fremde Pläne 404). */
export default async function SitzplanDruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModulePage("sitzplan");
  const { perms } = await requireUser();
  const view = await getPlan(await getDb(), perms, decodeURIComponent((await params).id), toBerlinDate(new Date()), { photos: false });
  if (!view) notFound();
  const { plan } = view;
  const desks = new Set(plan.desks);
  const at = new Map(view.seats.map((s) => [deskKey(s.row, s.col), view.students.find((x) => x.id === s.studentId)]));
  const seated = new Set(view.seats.map((s) => s.studentId));
  const without = view.students.filter((s) => !seated.has(s.id));
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/sitzplan/${plan.id}`}>Zurück zum Sitzplan</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-4">
        <DruckKopf
          eyebrow="Sitzplan"
          title={plan.title}
          subtitle={[view.groupName, view.subjectName, view.roomName].filter(Boolean).join(" · ")}
          stamp={`Stand ${stamp.format(new Date())}`}
        />
        <div className="rounded border border-ink/40 py-1 text-center text-sm font-medium">vorn · Tafel</div>
        <table className="w-full table-fixed border-separate border-spacing-1" aria-label="Sitzplan">
          <tbody>
            {Array.from({ length: plan.rows }, (_, row) => (
              <tr key={row}>
                {Array.from({ length: plan.cols }, (_, col) => {
                  const k = deskKey(row, col);
                  const s = at.get(k);
                  return (
                    <td key={col} className={desks.has(k) ? "h-14 border border-ink/60 px-1 text-center align-middle text-sm leading-tight" : "h-14"}>
                      {s && (
                        <>
                          <span className="block font-semibold">{s.firstName}</span>
                          <span className="block">{s.lastName}</span>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {without.length > 0 && <p className="text-sm">Ohne Platz: {without.map((s) => s.name).join(", ")}</p>}
      </main>
    </div>
  );
}
