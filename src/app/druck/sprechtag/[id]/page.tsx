import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { TZ } from "@/core/time";
import { MANAGE, OFFER, allAppointments, formatEventDay, getEvent, teacherAppointments, teacherBoards, type AppointmentView } from "@/modules/sprechtag/service";
import { roomLabel, slotEnd, slotsFor } from "@/modules/sprechtag/slots";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Sprechtag drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/**
 * P4-53: Druck zum Elternsprechtag – „plan“: Plan je Lehrkraft (Zeit, Schüler:in, Klasse, buchende Person; Lehrkraft nur den
 * eigenen, Verwaltung jeden bzw. alle), „aushang“: Raumliste für das Foyer (Lehrkräfte und Räume, keine Familien).
 */
export default async function SprechtagDruckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ art?: string; lehrkraft?: string }> }) {
  await requireModulePage("sprechtag");
  const { perms } = await requireUser();
  const manage = hasPermission(perms, MANAGE);
  if (!manage && !hasPermission(perms, OFFER)) notFound();
  const db = await getDb();
  const e = await getEvent(db, (await params).id);
  if (!e) notFound();
  const sp = await searchParams;
  const boards = await teacherBoards(db, e);
  const day = formatEventDay(e.date);
  const nav = (
    <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
      <Button asChild variant="ghost" size="sm">
        <Link href={`/sprechtag/${e.id}`}>Zurück zum Sprechtag</Link>
      </Button>
      <PrintButton />
    </nav>
  );

  if (sp.art === "aushang") {
    return (
      <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
        {nav}
        <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
          <DruckKopf eyebrow="Elternsprechtag" title={`${e.title} – Räume`} subtitle={`${day} · ${e.startsAt}–${e.endsAt} Uhr`} stamp={`Stand ${stamp.format(new Date())}`} />
          <table className="w-full border-collapse text-base [&_td]:border-b [&_td]:border-ink/30 [&_td]:py-2 [&_th]:border-b-2 [&_th]:border-ink [&_th]:py-2 [&_th]:text-left">
            <thead>
              <tr>
                <th>Lehrkraft</th>
                <th>Kürzel</th>
                <th>Raum</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((b) => (
                <tr key={b.teacherId}>
                  <td>{b.name}</td>
                  <td>{b.shortCode ?? ""}</td>
                  <td className="font-semibold">{b.roomName ?? b.roomId ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </main>
      </div>
    );
  }

  // Plan: eigene Person, mit „manage“ eine gewählte oder alle Lehrkräfte mit Teilnahme
  const teacherIds = manage ? (sp.lehrkraft ? [sp.lehrkraft] : boards.map((b) => b.teacherId)) : [perms.userId];
  const appts: AppointmentView[] = manage ? await allAppointments(db, perms, e.id) : await teacherAppointments(db, perms, e.id, perms.userId);
  const slots = slotsFor(e);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      {nav}
      <main className="mx-auto flex max-w-[190mm] flex-col gap-8">
        {teacherIds.map((t) => {
          const b = boards.find((x) => x.teacherId === t);
          if (!b) return null;
          const mine = new Map(appts.filter((a) => a.teacherId === t).map((a) => [a.slot, a]));
          const offered = new Set([...b.free, ...b.taken]);
          return (
            <section key={t} aria-label={`Plan ${b.name}`} className="flex flex-col gap-3 break-after-page">
              <DruckKopf eyebrow={`${e.title} · ${day}`} title={`Plan ${b.name}`} subtitle={b.roomName ? roomLabel(b.roomName) : undefined} stamp={`Stand ${stamp.format(new Date())}`} />
              <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-ink/30 [&_td]:py-1.5 [&_th]:border-b-2 [&_th]:border-ink [&_th]:py-1.5 [&_th]:text-left">
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Schüler:in</th>
                    <th>Klasse</th>
                    <th>gebucht von</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => {
                    const a = mine.get(s);
                    return (
                      <tr key={s}>
                        <td className="tabular-nums">
                          {s}–{slotEnd(s, e.slotMinutes)}
                        </td>
                        <td>{a ? a.studentName : offered.has(s) ? "" : "–"}</td>
                        <td>{a?.className ?? ""}</td>
                        <td>{a?.bookedByName ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })}
      </main>
    </div>
  );
}
