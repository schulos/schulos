import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ROLES } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { actorFromPerms, assignableRoles } from "@/modules/verwaltung/escalation";
import { createUserAction } from "@/modules/verwaltung/actions";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { UserForm } from "../user-form";

export const metadata: Metadata = { title: "Benutzer anlegen" };

export default async function NeuerBenutzerPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.users")) notFound();
  // SEC-04: nur Rollen anbieten, die die Person vergeben darf (Admin nur für Admins)
  const roles = await assignableRoles(await getDb(), actorFromPerms(perms), ROLES);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Benutzer" title="Benutzer anlegen" />
      <Card>
        <UserForm mode="create" action={createUserAction} roles={roles} />
      </Card>
    </main>
  );
}
