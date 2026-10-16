import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { hasPermission } from "@/core/permissions";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.users")) notFound();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Schüler:innen importieren" />
      <Card>
        <ImportWizard />
      </Card>
    </main>
  );
}
