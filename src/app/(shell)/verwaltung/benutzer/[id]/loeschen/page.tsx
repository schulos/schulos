import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ROLE_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { requestErasureAction } from "@/core/privacy/actions";
import { accountErasureImpact, type ImpactEffect } from "@/core/privacy/konto";
import { getUserDetail } from "@/modules/verwaltung/users";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Löschung auf Antrag" };

const SECTIONS: { effect: ImpactEffect; title: string; hint: string }[] = [
  {
    effect: "record",
    title: "Bleibt wegen Aktenpflicht",
    hint: "Das Klassenbuch ist Schulakte (§ 9 VO-DV I). Solange es im Live-System steht, bleibt das Konto gesperrt bestehen; der Löschlauf löscht es, sobald die Akte archiviert und abgelaufen ist.",
  },
  { effect: "deleted", title: "Wird gelöscht", hint: "Diese Daten gehören zum Konto und werden mit ihm gelöscht – Dateien eingeschlossen." },
  {
    effect: "anonymized",
    title: "Bleibt ohne Namen",
    hint: "Diese Einträge gehören anderen (z. B. Gruppen, Termine, Vertretungen). Der Verweis auf die Person wird geleert.",
  },
];

/** Löschung auf Antrag (Art. 17 DSGVO): zeigt vorab, was gelöscht wird und was wegen der Aktenpflicht bleibt. */
export default async function LoeschenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fehler?: string; vorgemerkt?: string }>;
}) {
  const { perms, user: me } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const db = await getDb();
  const detail = await getUserDetail(db, id);
  if (!detail) notFound();
  const { user } = detail;
  const impact = await accountErasureImpact(db, id);
  const back = `/verwaltung/benutzer/${encodeURIComponent(id)}`;

  return (
    <main className="flex flex-col gap-6">
      <Link href={back} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> {user.name}
      </Link>
      <PageHeader eyebrow={`${ROLE_LABELS[user.role]} · ${user.username}`} title="Löschung auf Antrag" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Art. 17 DSGVO: Auf Antrag wird das Konto ohne die übliche Karenz gelöscht – soweit keine Aufbewahrungspflicht entgegensteht. Das Konto wird sofort
        gesperrt. Der Vorgang steht im Audit-Log und im Löschprotokoll (nur Anzahlen).
      </p>
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.vorgemerkt && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Antrag vorgemerkt: Das Konto ist gesperrt. Es wird gelöscht, sobald die Aktenpflicht nicht mehr entgegensteht.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {SECTIONS.map((s) => {
          const items = impact.filter((i) => i.effect === s.effect);
          return (
            <Card key={s.effect}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {s.title}
                    <Badge tone={s.effect === "record" && items.length ? "warn" : "neutral"}>{items.reduce((n, i) => n + i.count, 0)}</Badge>
                  </span>
                }
              />
              <p className="mb-3 text-xs text-muted">{s.hint}</p>
              {items.length === 0 ? (
                <p className="text-sm text-muted">nichts</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {items.map((i) => (
                    <li key={i.table} className="flex justify-between gap-3">
                      <span>{i.purpose}</span>
                      <span className="tabular-nums text-muted">{i.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {user.erasureRequestedOn ? (
        <p className="text-sm text-muted">Der Antrag ist bereits vorgemerkt.</p>
      ) : user.id === me.id ? (
        <p className="text-sm text-muted">Das eigene Konto kann nicht gelöscht werden.</p>
      ) : (
        <form action={requestErasureAction.bind(null, user.id)} aria-label="Löschung auf Antrag" className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" value="1" className="size-4 accent-[var(--accent)]" /> Antrag geprüft (Identität, Umfang)
          </label>
          <Button type="submit" variant="danger">
            {impact.some((i) => i.effect === "record") ? "Sperren und Löschung vormerken" : "Konto jetzt löschen"}
          </Button>
        </form>
      )}
    </main>
  );
}
