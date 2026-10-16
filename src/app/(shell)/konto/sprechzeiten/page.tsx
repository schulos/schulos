import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { MAX_OFFICE_HOURS } from "@/modules/verwaltung/users";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { OfficeHoursForm } from "./form";

export const metadata: Metadata = { title: "Sprechzeiten und Raum" };
export const dynamic = "force-dynamic";

/** Q5-25: Die Schulsozialarbeit (Rolle Beratung) pflegt Sprechzeiten und Raum selbst; alle anderen Rollen: 404. */
export default async function SprechzeitenPage() {
  const { user } = await requireUser();
  if (user.role !== "beratung") notFound();
  const [me] = await (await getDb()).select({ officeHours: users.officeHours }).from(users).where(eq(users.id, user.id));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="Sprechzeiten und Raum" />
      <Card className="max-w-2xl">
        <CardHeader title="Im Adressbuch" />
        <OfficeHoursForm current={me?.officeHours ?? ""} max={MAX_OFFICE_HOURS} />
        <p className="mt-3 text-sm text-muted">Das Sekretariat kann die Angabe ebenfalls ändern (Benutzerverwaltung).</p>
      </Card>
    </main>
  );
}
