import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { leaveDecidersMissing } from "@/modules/abwesenheiten/beurlaubung";
import { CONFIRM_TEXT, NOTE_MAX, readSetup, SETUP_STATUSES } from "@/core/privacy/einrichtung";
import { confirmSetupAction, revokeSetupAction, setTopicAction } from "@/core/privacy/einrichtung-actions";
import { PRIVACY_TEXT_FIELDS, type PrivacyTextKey } from "@/core/privacy/hinweise";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ConfirmForm, TopicForm } from "./setup-forms";

export const metadata: Metadata = { title: "Datenschutz-Einrichtung" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });
const statuses = Object.entries(SETUP_STATUSES).map(([value, label]) => ({ value, label }));

/** DS-12: Datenschutz-Einrichtung durch die Schule (Verwaltung → Datenschutz). */
export default async function EinrichtungPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const db = await getDb();
  const s = await readSetup(db);
  // GATE-4f C-10: niemand außer Admins darf über Beurlaubungen über der Grenze entscheiden – sichtbar machen, nicht still vergeben
  const leaveRightMissing = (await moduleOn("abwesenheiten")) && (await leaveDecidersMissing(db));
  const doneTopics = s.topics.filter((t) => t.done).length;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Datenschutz"
        title="Datenschutz-Einrichtung"
        actions={
          <span className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/druck/datenschutz-einrichtung">Nachweis drucken</Link>
            </Button>
            <form method="post" action="/api/verwaltung/datenschutz-einrichtung">
              <Button type="submit">Nachweis als JSON</Button>
            </form>
          </span>
        }
      />
      <p className="max-w-3xl text-muted">
        Die Schule ist Verantwortliche und entscheidet; SchulOS liefert vorsichtige Vorgaben ohne Gewähr. Gehen Sie die Punkte mit Ihrer bzw. Ihrem
        Datenschutzbeauftragten durch – dieselbe Liste steht mit Hintergrund und Fragen in der DSB-Checkliste von SchulOS.
      </p>
      <p role="status" data-setup-state={s.done ? "fertig" : "offen"} className={s.done ? "text-sm font-medium text-success" : "text-sm font-medium text-warn"}>
        {s.done ? "Einrichtung abgeschlossen." : `Noch offen: ${s.confirmed ? "" : "Bestätigung und "}${s.topics.length - doneTopics} von ${s.topics.length} Punkten.`}
      </p>

      <Card aria-labelledby="schritt1">
        <CardHeader title={<span id="schritt1">1. Verantwortliche und Datenschutzbeauftragte:r</span>} />
        {s.missingTexts.length > 0 && (
          <p role="alert" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            Noch nicht eingetragen: {s.missingTexts.map((k) => PRIVACY_TEXT_FIELDS[k as PrivacyTextKey].label).join(", ")} –{" "}
            <Link href="/verwaltung/datenschutz/angaben" className="underline">
              Hinweise und VVT
            </Link>
            .
          </p>
        )}
        {s.confirmed ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              <Badge tone="success">bestätigt</Badge> am {dayFmt.format(new Date(s.confirmedAt!))}
            </p>
            <p className="text-muted">{CONFIRM_TEXT}</p>
            {s.confirmedDpo && <p className="whitespace-pre-line">Datenschutzbeauftragte:r: {s.confirmedDpo}</p>}
            <form action={revokeSetupAction}>
              <Button type="submit" variant="ghost" size="sm">
                Bestätigung zurücknehmen (z. B. neue DSB)
              </Button>
            </form>
          </div>
        ) : (
          <ConfirmForm action={confirmSetupAction} text={CONFIRM_TEXT} />
        )}
      </Card>

      <section aria-labelledby="schritt2" className="flex flex-col gap-4">
        <h2 id="schritt2" className="font-display text-xl font-bold">
          2. Schalter, Fristen und Funktionen ({doneTopics} von {s.topics.length} erledigt)
        </h2>
        {s.topics.map((t) => (
          <Card key={t.id} data-topic={t.id} aria-labelledby={`t-${t.id}`}>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`t-${t.id}`} className="font-semibold">
                §{t.nr} {t.title}
              </h3>
              {t.stale ? <Badge tone="warn">seit der Prüfung geändert</Badge> : t.status ? <Badge tone="success">{SETUP_STATUSES[t.status]}</Badge> : <Badge tone="warn">offen</Badge>}
            </header>
            <dl className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[12rem_minmax(0,1fr)]">
              <dt className="text-muted">Was SchulOS tut</dt>
              <dd>{t.schulos}</dd>
              <dt className="text-muted">Vorgabe</dt>
              <dd>{t.vorgabe}</dd>
              <dt className="text-muted">Die Schule entscheidet</dt>
              <dd>{t.schule}</dd>
              {t.baustein && (
                <>
                  <dt className="text-muted">Baustein Nutzungsordnung</dt>
                  <dd>
                    <blockquote className="border-l-2 border-border pl-3 whitespace-pre-line">{t.baustein}</blockquote>
                  </dd>
                </>
              )}
              {t.where && (
                <>
                  <dt className="text-muted">In SchulOS</dt>
                  <dd>
                    <Link href={t.where.href} className="text-accent-ink hover:underline">
                      {t.where.label}
                    </Link>
                  </dd>
                </>
              )}
            </dl>
            {t.id === "beurlaubung" && leaveRightMissing && (
              <p role="alert" data-hint="leave-decide" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                Das Recht „Beurlaubungen über der Grenze entscheiden“ hat außer Admin-Konten niemand. Anträge über der Grenze landen
                dann nur beim Admin –{" "}
                <Link href="/verwaltung/rechte" className="underline">
                  Recht vergeben
                </Link>{" "}
                (z. B. an die Gruppe Schulleitung).
              </p>
            )}
            {t.settingsState.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <th>Einstellung</th>
                    <th>Aktuell</th>
                    <th>Vorgabe</th>
                  </tr>
                </thead>
                <tbody>
                  {t.settingsState.map((x) => (
                    <tr key={x.key}>
                      <td>
                        {x.label}
                        <span className="block text-xs text-muted">
                          {x.moduleName}
                          {!x.moduleEnabled && " (Modul aus)"}
                        </span>
                      </td>
                      <td>
                        {x.valueLabel} {x.changed && <Badge tone="soft">geändert</Badge>}
                      </td>
                      <td className="text-muted">{x.defaultLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {t.id === "loeschfristen" && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">Alle Löschfristen ({s.retention.length} Datenarten)</summary>
                <Table className="mt-2">
                  <thead>
                    <tr>
                      <th>Bereich</th>
                      <th>Datenart</th>
                      <th>Frist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.retention.map((r) => (
                      <tr key={`${r.table}-${r.scope ?? ""}`}>
                        <td>{r.ownerName}</td>
                        <td>
                          {r.purpose}
                          {r.scope && <span className="text-muted"> · {r.scope}</span>}
                        </td>
                        <td>
                          {r.rule}
                          {r.setting && <span className="block text-xs text-muted">einstellbar</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </details>
            )}
            {t.checkedAt && <p className="text-xs text-muted">Geprüft am {dayFmt.format(new Date(t.checkedAt))}</p>}
            <TopicForm action={setTopicAction.bind(null, t.id)} title={t.title} status={t.status ?? "offen"} note={t.note} statuses={statuses} max={NOTE_MAX} />
          </Card>
        ))}
      </section>

      <Card aria-labelledby="schritt3">
        <CardHeader title={<span id="schritt3">3. Nachweis für die DSB</span>} />
        <p className="text-sm text-muted">
          „Datenschutz-Konfiguration Stand …“ mit Bestätigung, allen Punkten samt Status und Bemerkung, allen Moduleinstellungen und allen Löschfristen –
          zum Drucken (auch als PDF über den Druckdialog) oder als JSON. Jeder Abruf steht im Audit-Log.
        </p>
      </Card>
    </main>
  );
}
