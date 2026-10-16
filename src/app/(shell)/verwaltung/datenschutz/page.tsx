import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { hasPermission } from "@/core/permissions";
import { Button } from "@schulos/ui/button";
import { collectRetention, RETENTION_CLASSES, ruleText, type RetentionDecl } from "@/core/retention";
import { getDb } from "@/core/db/client";
import { readPeriods } from "@/core/privacy/fristen";
import { MODULES } from "@/modules";
import { Badge } from "@schulos/ui/badge";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Löschkonzept" };

function Rule({ decl, periods }: { decl: RetentionDecl; periods: ReadonlyMap<string, number> }) {
  if ("follows" in decl) return <span className="text-muted">mit „{decl.follows}“ gelöscht</span>;
  const days = decl.period ? periods.get(decl.period) : undefined;
  const rule = ruleText(decl.class, days);
  return (
    <span className="flex flex-col gap-1">
      <Badge tone="soft" className="w-fit">
        {decl.class}
      </Badge>
      <span>{rule}</span>
      {decl.period && (
        <span className="text-xs text-muted">{rule === RETENTION_CLASSES[decl.class].rule ? "Vorgabe, einstellbar" : "von der Schule eingestellt"} (Rechte &amp; Module)</span>
      )}
    </span>
  );
}

export default async function DatenschutzPage() {
  const { perms } = await requireUser();
  const entries = collectRetention(MODULES);
  const periods = await readPeriods(await getDb(), entries);
  const owners = ["core", ...MODULES.map((m) => m.id)].filter((o) => entries.some((e) => e.owner === o));
  const ownerName = (o: string) => (o === "core" ? "Grundsystem" : (MODULES.find((m) => m.id === o)?.name ?? o));

  return (
    <main className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Datenschutz"
        title="Löschkonzept"
        actions={
          hasPermission(perms, "verwaltung.privacy") ? (
            <span className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/verwaltung/datenschutz/einrichtung">Einrichtung</Link>
              </Button>
              <Button asChild>
                <Link href="/verwaltung/datenschutz/angaben">Hinweise und VVT</Link>
              </Button>
              <Button asChild>
                <Link href="/verwaltung/schuljahreswechsel">Schuljahreswechsel</Link>
              </Button>
              <Button asChild variant="primary">
                <Link href="/verwaltung/datenschutz/loeschlauf">Löschlauf und Sperren</Link>
              </Button>
            </span>
          ) : undefined
        }
      />
      <p className="max-w-3xl text-muted">
        Baustein SchulOS für das Löschkonzept der Schule (Gliederung nach DIN 66398). Jede Tabelle mit Personenbezug ist einer Löschklasse zugeordnet; die
        Übersicht entsteht direkt aus den Modulen und ist damit immer aktuell.
      </p>

      <section aria-labelledby="lk" className="flex flex-col gap-3">
        <h2 id="lk" className="font-display text-xl font-bold">
          Löschklassen
        </h2>
        <Table>
          <thead>
            <tr>
              <th>Klasse</th>
              <th>Startzeitpunkt</th>
              <th>Regelfrist</th>
              <th>Einstellbar bis</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(RETENTION_CLASSES).map(([id, c]) => (
              <tr key={id}>
                <td>
                  <span className="flex flex-col gap-1">
                    <Badge tone="soft" className="w-fit">
                      {id}
                    </Badge>
                    <span className="font-medium">{c.label}</span>
                  </span>
                </td>
                <td>{c.start}</td>
                <td>{c.rule}</td>
                <td className="text-muted">{c.max}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      {owners.map((o) => (
        <section key={o} aria-labelledby={`da-${o}`} className="flex flex-col gap-3">
          <h2 id={`da-${o}`} className="font-display text-xl font-bold">
            {ownerName(o)}
          </h2>
          <Table>
            <thead>
              <tr>
                <th>Datenart</th>
                <th>Datenkategorien</th>
                <th>Löschung</th>
              </tr>
            </thead>
            <tbody>
              {entries
                .filter((e) => e.owner === o)
                .map(({ decl }) => (
                  <tr key={`${decl.table}-${decl.scope ?? ""}`}>
                    <td className="min-w-56">
                      <span className="flex flex-col gap-1">
                        <span className="font-medium">
                          {decl.purpose}
                          {decl.scope && <span className="text-muted"> · {decl.scope}</span>}
                        </span>
                        <code className="text-xs text-muted">{decl.table}</code>
                        {decl.note && <span className="text-xs text-muted">{decl.note}</span>}
                      </span>
                    </td>
                    <td className="min-w-48">{decl.categories.join(", ")}</td>
                    <td className="min-w-44">
                      <Rule decl={decl} periods={periods} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </section>
      ))}
    </main>
  );
}
