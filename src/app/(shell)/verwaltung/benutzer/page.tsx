import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { UserPlus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groups, ROLES, type Role } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { listUsers, PAGE_SIZE } from "@/modules/verwaltung/users";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";
import { Avatar, EmptyState, initials, PageHeader } from "@schulos/ui/misc";
import { Pagination, Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Benutzer" };

type Params = { q?: string; role?: string; klasse?: string; status?: string; page?: string };

export default async function BenutzerPage({ searchParams }: { searchParams: Promise<Params & { geloescht?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.users")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const role = (ROLES as readonly string[]).includes(sp.role ?? "") ? (sp.role as Role) : undefined;
  const status = sp.status === "locked" || sp.status === "active" ? sp.status : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const classes = await db.select({ id: groups.id, slug: groups.slug }).from(groups).where(eq(groups.kind, "klasse")).orderBy(asc(groups.gradeLevel), asc(groups.slug));
  const klasse = classes.find((c) => c.slug === sp.klasse);
  const { rows, total } = await listUsers(db, { q: sp.q, role, status, groupId: klasse?.id, page });

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title="Benutzer"
        actions={
          <Button asChild variant="primary">
            <Link href="/verwaltung/benutzer/neu">
              <UserPlus aria-hidden /> Benutzer anlegen
            </Link>
          </Button>
        }
      />

      {sp.geloescht && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Konto auf Antrag gelöscht. Der Vorgang steht im Löschprotokoll.
        </p>
      )}

      <form role="search" className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <Input name="q" type="search" defaultValue={sp.q} placeholder="Name, Benutzername oder Kürzel" aria-label="Suche" />
        <Select name="role" defaultValue={role ?? ""} aria-label="Rolle">
          <option value="">Alle Rollen</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        <Select name="klasse" defaultValue={klasse?.slug ?? ""} aria-label="Klasse">
          <option value="">Alle Klassen</option>
          {classes.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.slug.toUpperCase()}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">Jeder Status</option>
          <option value="active">Aktiv</option>
          <option value="locked">Gesperrt</option>
        </Select>
        <Button type="submit">Filtern</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="Keine Benutzer gefunden">Andere Suchbegriffe oder Filter probieren.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Benutzername</th>
              <th>Rolle</th>
              <th>Klasse</th>
              <th>E-Mail</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/verwaltung/benutzer/${u.id}`} className="flex items-center gap-3 font-medium hover:underline">
                    <Avatar label={u.shortCode ?? initials(u.name)} tone="soft" className="size-8 text-xs" />
                    <span>
                      {u.lastName}, {u.firstName}
                    </span>
                  </Link>
                </td>
                <td className="text-muted">{u.username}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.classes.map((c) => c.toUpperCase()).join(", ")}</td>
                <td>{u.hasEmail ? u.emailVerified ? <Badge tone="success">bestätigt</Badge> : <Badge tone="warn">unbestätigt</Badge> : <span className="text-muted">–</span>}</td>
                <td>
                  {u.status === "active" ? <Badge tone="success">Aktiv</Badge> : <Badge tone="danger">{u.leftOn ? "Abgang" : "Gesperrt"}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} basePath="/verwaltung/benutzer" params={{ q: sp.q, role, klasse: klasse?.slug, status }} />
    </main>
  );
}
