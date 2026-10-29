import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { SIGN_FORMATS, paginate, signFormat } from "@/core/etiketten/codes";
import { labelUrl, qrSvg } from "@/core/etiketten/qr";
import { roomHref } from "@/core/room-href";
import { getSchoolSettings } from "@/core/settings";
import { doorSigns } from "@/modules/verwaltung/tuer-qr";
import { QrSchild } from "@/ui/qr-schild";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Türschilder drucken" };

type Search = { raum?: string | string[]; alle?: string; gebaeude?: string; format?: string };

/**
 * RS-11: Türschilder mit Raumname, Gebäude/Etage und Tür-QR (`/r/<code>`) – einzeln oder als Sammeldruck (`raum` mehrfach,
 * `gebaeude`, `alle=1`). Nur Räume, deren Daten die Person pflegt (`canEditRoomInfo`); fehlende Codes entstehen hier, vorhandene
 * bleiben. A5 quer (zwei je A4-Blatt) oder A4 hoch.
 */
export default async function TuerschilderDruckPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const sp = await searchParams;
  const format = signFormat(sp.format);
  const ids = sp.raum === undefined ? [] : Array.isArray(sp.raum) ? sp.raum : [sp.raum];
  const all = sp.alle === "1" || Boolean(sp.gebaeude);
  if (!all && ids.length === 0)
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <p role="alert">Keine Räume gewählt.</p>
        <Button asChild variant="secondary" size="sm">
          <Link href="/raeume/tuerschilder">Zurück zur Auswahl</Link>
        </Button>
      </main>
    );
  const db = await getDb();
  const signs = await doorSigns(db, perms, all ? "alle" : ids.slice(0, 500), sp.gebaeude ? { buildingId: sp.gebaeude } : {});
  if (signs.length === 0) notFound();
  const school = await getSchoolSettings();
  const pages = paginate(signs, SIGN_FORMATS[format].perPage);
  const query = (f: string) => {
    const q = new URLSearchParams();
    for (const id of ids) q.append("raum", id);
    if (sp.alle === "1") q.set("alle", "1");
    if (sp.gebaeude) q.set("gebaeude", sp.gebaeude);
    q.set("format", f);
    return `?${q}`;
  };
  const back = ids.length === 1 && !all ? `${roomHref(ids[0]!)}#tuer-qr` : "/raeume/tuerschilder";
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{"@media print { @page { size: A4 portrait; margin: 0; } }"}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={back}>Zurück</Link>
          </Button>
          {(Object.keys(SIGN_FORMATS) as (keyof typeof SIGN_FORMATS)[]).map((f) => (
            <Button key={f} asChild variant={f === format ? "secondary" : "ghost"} size="sm">
              <Link href={query(f)} aria-current={f === format ? "page" : undefined}>
                {SIGN_FORMATS[f].label}
              </Link>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PrintButton />
          <span className="text-sm text-muted">
            {signs.length === 1 ? "1 Türschild" : `${signs.length} Türschilder`} · in tatsächlicher Größe drucken, ohne Kopf-/Fußzeilen
          </span>
        </div>
      </nav>
      <main aria-label="Türschilder" className="flex flex-col gap-6 print:gap-0">
        <h1 className="sr-only">Türschilder drucken</h1>
        {pages.map((p, i) => (
          <section key={i} aria-label={`Blatt ${i + 1}`} className="flex shrink-0 break-after-page flex-col bg-white" style={{ width: "210mm" }}>
            {p.map((s) => (
              <QrSchild
                key={s.roomId}
                format={format}
                c={{
                  eyebrow: school.name,
                  title: s.roomId,
                  subtitle: s.name !== s.roomId && s.name !== `Raum ${s.roomId}` ? s.name : undefined,
                  lines: [[s.building, s.floor].filter(Boolean).join(" · ")].filter(Boolean),
                  qrSvg: qrSvg(labelUrl("raum", s.code)),
                  url: labelUrl("raum", s.code),
                  hint: "QR-Code scannen und anmelden: Belegung, Mangel melden, Raum buchen.",
                }}
              />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
