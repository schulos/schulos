import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { canManage, getVerfahren, listSlots } from "@/modules/anmeldung/service";
import { listRooms } from "@/modules/verwaltung/rooms";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SlotDelete, SlotGenerator } from "../../forms";
import { dayFmt, timeFmt, VerfahrenBadge, VerfahrenNav } from "../../shared";

export const metadata: Metadata = { title: "Gesprächstermine" };
export const dynamic = "force-dynamic";

export default async function TerminePage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const [slots, rooms] = await Promise.all([listSlots(db, v.id), listRooms(db, { activeOnly: true })]);
  const manage = canManage(perms) && v.status !== "abgeschlossen";
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) byDay.set(toBerlinDate(s.startsAt), [...(byDay.get(toBerlinDate(s.startsAt)) ?? []), s]);
  const roomName = (rid: string | null) => (rid ? (rooms.find((r) => r.id === rid)?.name ?? rid) : "–");
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.name} actions={<VerfahrenBadge status={v.status} />} />
      <VerfahrenNav id={v.id} current="termine" />
      {manage && (
        <Card className="max-w-4xl">
          <CardHeader title="Termine erzeugen" />
          <SlotGenerator id={v.id} rooms={rooms.map((r) => ({ id: r.id, name: r.id === r.name ? r.id : `${r.name} (${r.id})` }))} />
        </Card>
      )}
      <section aria-label="Termine" className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold" data-testid="termine-summe">
          {slots.length} Termine · {slots.reduce((n, s) => n + s.capacity, 0)} Plätze · {slots.reduce((n, s) => n + s.booked, 0)} gebucht
        </h2>
        {slots.length === 0 && <EmptyState title="Noch keine Gesprächstermine" />}
        {[...byDay].map(([d, list]) => (
          <Card key={d} aria-label={dayFmt.format(list[0]!.startsAt)}>
            <CardHeader title={dayFmt.format(list[0]!.startsAt)} />
            <Table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Raum</th>
                  <th className="text-right">Plätze</th>
                  <th className="text-right">gebucht</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const label = `${timeFmt.format(s.startsAt)}–${timeFmt.format(s.endsAt)}`;
                  return (
                    <tr key={s.id}>
                      <td className="tabular-nums">{label}</td>
                      <td>{roomName(s.roomId)}</td>
                      <td className="text-right tabular-nums">{s.capacity}</td>
                      <td className="text-right tabular-nums">{s.booked}</td>
                      {manage && <td className="text-right">{s.booked === 0 && <SlotDelete verfahrenId={v.id} slotId={s.id} label={`${d} ${label}`} />}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        ))}
      </section>
    </main>
  );
}
