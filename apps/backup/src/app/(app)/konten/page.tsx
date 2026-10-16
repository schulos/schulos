import type { Metadata } from "next";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { listAccounts } from "@/accounts/service";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db/client";
import { AccountActions, CreateAccountForm } from "./forms";

export const metadata: Metadata = { title: "Konten" };
export const dynamic = "force-dynamic";

export default async function KontenPage() {
  const me = await requireUser();
  const list = await listAccounts(await getDb());
  return (
    <>
      <PageHeader eyebrow="Backupserver" title="Konten" />
      <p className="text-sm text-muted">
        Alle Konten dürfen alles – auch Sicherungen wiederherstellen. Deshalb ist die Zwei-Faktor-Anmeldung Pflicht, und
        Zurücksetzen geht nur durch einen anderen Admin.
      </p>
      {list.map((a) => (
        <Card key={a.id} aria-label={a.name}>
          <CardHeader title={a.name} />
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="font-mono text-muted">{a.username}</span>
            {a.status === "locked" && <Badge tone="danger">gesperrt</Badge>}
            {a.mustChangePassword && <Badge tone="warn">Startpasswort</Badge>}
            <Badge tone={a.twoFactorEnabled ? "success" : "warn"}>{a.twoFactorEnabled ? "Zwei-Faktor aktiv" : "Zwei-Faktor fehlt"}</Badge>
            {a.id === me.id && <Badge>du</Badge>}
          </div>
          {a.id !== me.id && <AccountActions id={a.id} username={a.username ?? ""} locked={a.status === "locked"} />}
        </Card>
      ))}
      <Card aria-label="Neues Konto">
        <CardHeader title="Konto anlegen" />
        <CreateAccountForm />
      </Card>
    </>
  );
}
