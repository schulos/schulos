import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { rooms } from "@/core/db/schema";
import { createTicketAction } from "@/modules/gebaeude/actions";
import { canManage, canReport } from "@/modules/gebaeude/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { ReportForm } from "./report-form";

export const metadata: Metadata = { title: "Mangel melden" };

/** Mangel oder Störung melden – mit `?raum=112` aus Raumbelegung und Kursraum vorbelegt. */
export default async function MeldenPage({ searchParams }: { searchParams: Promise<{ raum?: string }> }) {
  const { perms } = await requireUser();
  if (!canReport(perms) && !canManage(perms)) notFound();
  const db = await getDb();
  const list = await db.select({ id: rooms.id, name: rooms.name, building: rooms.building }).from(rooms).where(eq(rooms.active, true)).orderBy(asc(rooms.id));
  const raum = (await searchParams).raum ?? "";
  const options = list.map((r) => ({ value: r.id, label: [r.id === r.name ? `Raum ${r.id}` : `${r.id} – ${r.name}`, r.building].filter(Boolean).join(" · ") }));
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Mangel melden"
        actions={
          <Link href="/gebaeude" className="text-sm font-medium text-accent-ink hover:underline">
            Zur Übersicht
          </Link>
        }
      />
      <Card>
        <ReportForm action={createTicketAction} rooms={options} initialRoom={list.some((r) => r.id === raum) ? raum : ""} />
      </Card>
    </main>
  );
}
