import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KINDS, type GroupKind } from "@/core/db/schema";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { listGroups } from "@/modules/verwaltung/groups";
import { gradeLabel, listGradeLevels } from "@/modules/verwaltung/stammdaten";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Gruppen" };

export default async function GruppenPage({ searchParams }: { searchParams: Promise<{ q?: string; art?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.groups")) notFound();
  const sp = await searchParams;
  const kind = (GROUP_KINDS as readonly string[]).includes(sp.art ?? "") ? (sp.art as GroupKind) : undefined;
  const db = await getDb();
  const [rows, grades] = await Promise.all([listGroups(db, { q: sp.q, kind }), listGradeLevels(db)]);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title="Gruppen"
        actions={
          <Button asChild variant="primary">
            <Link href="/verwaltung/gruppen/neu">
              <Plus aria-hidden /> Gruppe anlegen
            </Link>
          </Button>
        }
      />
      <form role="search" className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[2fr_1fr_auto]">
        <Input name="q" type="search" defaultValue={sp.q} placeholder="Name oder Kurzname" aria-label="Suche" />
        <Select name="art" defaultValue={kind ?? ""} aria-label="Art">
          <option value="">Alle Arten</option>
          {GROUP_KINDS.map((k) => (
            <option key={k} value={k}>
              {GROUP_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <Button type="submit">Filtern</Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="Keine Gruppen gefunden" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Art</th>
              <th>Jahrgang</th>
              <th>Leitung</th>
              <th className="text-right">Mitglieder</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/verwaltung/gruppen/${g.id}`} className="font-medium hover:underline">
                    {g.name}
                  </Link>
                </td>
                <td>
                  <Badge>{GROUP_KIND_LABELS[g.kind]}</Badge>
                </td>
                <td className="text-muted">{[gradeLabel(grades, g.gradeLevel), g.level].filter(Boolean).join(" · ")}</td>
                <td className="text-muted">{g.leaders.join(", ")}</td>
                <td className="text-right tabular-nums">{g.members}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </main>
  );
}
