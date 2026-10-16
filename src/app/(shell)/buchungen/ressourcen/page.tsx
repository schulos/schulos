import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { addResourceAction, toggleResourceAction } from "@/modules/buchungen/actions";
import { listResources, roomsWithoutResource } from "@/modules/buchungen/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ResourceForm } from "./resource-form";

export const metadata: Metadata = { title: "Ressourcen verwalten" };

export default async function RessourcenPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "buchungen.manage")) notFound();
  const db = await getDb();
  const [resources, freeRooms] = await Promise.all([listResources(db, true), roomsWithoutResource(db)]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Buchungen" title="Ressourcen verwalten" />
      <Card aria-labelledby="neu">
        <h2 id="neu" className="text-base font-semibold">
          Ressource hinzufügen
        </h2>
        <ResourceForm action={addResourceAction} rooms={freeRooms.map((r) => ({ id: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` }))} />
      </Card>
      <Table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Art</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Aktion</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <tr key={r.id}>
              <td className="font-medium">
                {r.name}
                {r.description && <span className="block text-xs font-normal text-muted">{r.description}</span>}
              </td>
              <td>{r.kind === "room" ? "Raum" : "Gerät"}</td>
              <td>{r.active ? <Badge tone="success">buchbar</Badge> : <Badge>deaktiviert</Badge>}</td>
              <td className="text-right">
                <form action={toggleResourceAction.bind(null, r.id, !r.active)}>
                  <Button type="submit" size="sm" variant="ghost" aria-label={`${r.active ? "Deaktivieren" : "Aktivieren"}: ${r.name}`}>
                    {r.active ? "Deaktivieren" : "Aktivieren"}
                  </Button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </main>
  );
}
