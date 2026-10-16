import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HEALTH_LABEL, IMMUTABLE_LABEL, immutableHealth, type BackupHealth, type ImmutableHealth } from "@schulos/server/agent-api";
import { CHANGE_LABEL } from "@schulos/server/release";
import { osSupportState, PROTOCOL_STEP_LABEL, rebootPendingDays, REBOOT_RED_DAYS, type OsSupportState } from "@schulos/server/system";
import { requireUser } from "@/core/auth/session";
import { backupStatus } from "@/core/backup/status";
import { getDb } from "@/core/db/client";
import { appRoleIsSuperuser, slowQueries, type QueryStats } from "@/core/db/statements";
import { hasPermission } from "@/core/permissions";
import { pendingOrder, readSystemStatus, statusIsStale } from "@/core/system/status";
import { TZ } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AlarmSettingsForm, ChannelForm, RebootForm, ReleaseForm, TestMailForm } from "./forms";
import { readAlarmSettings } from "@/core/system/security-alarms";
import { clamavTarget, clamavVersion } from "@/core/files/virus-scan";
import { crowdsecConfig, crowdsecStatus } from "@/core/crowdsec";
import { DisclaimerCard } from "../../_shell/disclaimer";
import { alarmRecipients, mailConfig } from "@schulos/server/mail";
import { outboxStats } from "@/core/mail";

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

/** B-51: Abfragen mit der meisten Gesamtzeit (pg_stat_statements) – nur mit dem Server-Postgres */
function QueryStatsCard({ stats }: { stats: QueryStats | null }) {
  return (
    <section aria-label="Langsame Abfragen" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Langsame Abfragen</h2>
      {!stats ? (
        <p className="text-sm text-muted">Nicht verfügbar – nur mit dem Postgres des Servers (pg_stat_statements), nicht in der Entwicklung.</p>
      ) : stats.queries.length === 0 ? (
        <p className="text-sm text-muted">Noch keine Abfragen erfasst.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            Die zehn Abfragen mit der meisten Datenbankzeit{stats.since ? ` seit ${fmt.format(stats.since)}` : ""}. Werte in den Abfragen sind
            durch Platzhalter ($1, $2 …) ersetzt.
          </p>
          <Table>
            <thead>
              <tr>
                <th>Abfrage</th>
                <th className="text-right">Aufrufe</th>
                <th className="text-right">Mittel</th>
                <th className="text-right">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {stats.queries.map((q, i) => (
                <tr key={i}>
                  <td className="max-w-xl font-mono text-xs break-all">{q.query}</td>
                  <td className="text-right tabular-nums">{num.format(q.calls)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{num.format(q.meanMs)} ms</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{num.format(q.totalMs / 1000)} s</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </section>
  );
}

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: TZ });
const HEALTH_TONE: Record<BackupHealth, "success" | "warn" | "danger"> = { ok: "success", overdue: "danger", failed: "danger", none: "warn" };
const IMMUTABLE_TONE: Record<ImmutableHealth, "success" | "warn" | "danger"> = { ok: "success", veraltet: "danger", fehlt: "danger", aus: "warn" };
const KIND_LABEL = { patch: "Fehlerbehebung", minor: "neue Funktionen", major: "größeres Update" } as const;
const OS_TEXT: Record<OsSupportState, { tone: "success" | "warn" | "danger" | "neutral"; label: string }> = {
  ok: { tone: "success", label: "mit Sicherheitsupdates" },
  "wechsel-empfohlen": { tone: "warn", label: "Versionswechsel empfohlen" },
  "nur-lts": { tone: "warn", label: "nur noch Langzeit-Support" },
  abgelaufen: { tone: "danger", label: "keine Sicherheitsupdates mehr" },
  unbekannt: { tone: "neutral", label: "Supportende unbekannt" },
};

export default async function SystemPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.system")) notFound();
  const status = readSystemStatus();
  const order = pendingOrder();
  const backup = backupStatus();
  const queryStats = <QueryStatsCard stats={await slowQueries(await getDb())} />;
  const superuser = await appRoleIsSuperuser(await getDb());

  const backupCard = (
    <Card aria-label="Backup">
      <CardHeader title="Backup" />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={HEALTH_TONE[backup.health]}>{HEALTH_LABEL[backup.health]}</Badge>
        <span>{backup.lastOkAt ? `letzte Sicherung ${fmt.format(backup.lastOkAt)}` : "noch keine Sicherung"}</span>
        <Link href="/verwaltung/backup" className="text-accent-ink underline underline-offset-2">
          Zum Backup
        </Link>
      </div>
      {backup.paired && (
        // SEC-11: unveränderliche Kopie (Schnappschüsse des Offsite-Ziels, geprüft vom Backupserver)
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm" aria-label="Unveränderliche Kopie">
          <span>Unveränderliche Kopie:</span>
          <Badge tone={IMMUTABLE_TONE[immutableHealth(backup.immutable)]}>{IMMUTABLE_LABEL[immutableHealth(backup.immutable)]}</Badge>
          <span className="text-muted">
            {backup.immutable?.lastAt
              ? `letzte ${fmt.format(new Date(backup.immutable.lastAt))}`
              : backup.immutable
                ? (backup.immutable.error ?? "kein Schnappschuss gefunden")
                : "Offsite-Kopie mit Schnappschüssen einrichten (INSTALLATION.md §4, SEC-11) – Schutz, falls Hauptsystem und Backupserver übernommen werden"}
          </span>
        </p>
      )}
      <p className="mt-2 text-sm text-muted">Vor jedem Update sichert SchulOS automatisch; ohne funktionierende Sicherung wird nicht aktualisiert.</p>
    </Card>
  );

  let mail: { to: string[]; from: string } | null = null;
  let mailError: string | null = null;
  try {
    // Transaktionsmails brauchen keine Alarm-Empfänger (P4-30) – fehlen sie, gibt es nur keine Alarme
    mail = mailConfig(process.env, { alarmTo: false });
  } catch (err) {
    mailError = err instanceof Error ? err.message : String(err);
  }
  const outbox = await outboxStats(await getDb());
  // SEC-14: Empfänger aus SCHULOS_ALARM_TO und aus dieser Seite
  const alarmSettings = await readAlarmSettings(await getDb());
  const alarmTo = mail ? alarmRecipients(mail.to, alarmSettings.recipients) : [];
  const mailCard = (
    <Card aria-label="E-Mail-Benachrichtigung">
      <CardHeader title="E-Mail" />
      {mailError ? (
        <p role="alert" className="text-sm whitespace-pre-line text-danger">
          {mailError}
        </p>
      ) : mail ? (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            SchulOS versendet Mails als <strong>{mail.from}</strong> (Bestätigungslinks, Hinweise an Eltern).
          </p>
          {alarmTo.length ? (
            <p>
              Alarme (Backup überfällig oder fehlgeschlagen, Update fehlgeschlagen, Speicherplatz knapp, Neustart ausstehend, unveränderliche
              Kopie veraltet, Häufung fehlgeschlagener Anmeldungen, neue Admin-/Verwaltungsrechte) gehen an <strong>{alarmTo.join(", ")}</strong> –
              einmal, bei Fortbestehen täglich, und wenn alles wieder in Ordnung ist (neue Rechte nur einmal).
            </p>
          ) : (
            <p className="text-muted">
              Keine Alarm-Empfänger eingetragen (<code>SCHULOS_ALARM_TO</code> oder unten) – Alarme gehen nicht per Mail raus.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">
          Nicht eingerichtet. In <code>schulos.env</code>: <code>SCHULOS_SMTP_HOST</code>, <code>SCHULOS_SMTP_FROM</code>, für Alarme{" "}
          <code>SCHULOS_ALARM_TO</code> (optional Port, Benutzer, Passwort).
        </p>
      )}
      <p className="mt-2 text-sm text-muted" aria-label="Warteschlange">
        Warteschlange: {outbox.pending} wartend · {outbox.sent} gesendet · {outbox.failed} gescheitert
        {outbox.oldestPending ? ` · älteste wartet seit ${fmt.format(outbox.oldestPending)}` : ""}
      </p>
      {mail && alarmTo.length > 0 && <TestMailForm />}
      {mail && <AlarmSettingsForm recipients={alarmSettings.recipients} threshold={alarmSettings.loginThreshold} />}
    </Card>
  );

  // P4-40b: Gerätezertifikate für den Personal-Außenzugang (eigene Seite)
  // SEC-01/P4-71: Schulnetz, Stichtag der 2FA-Pflicht, Inaktivitätsablauf – eigene Seite
  const anmeldungCard = (
    <Card aria-label="Anmeldung">
      <CardHeader title="Anmeldung" action={{ href: "/verwaltung/system/anmeldung", label: "Einstellen" }} />
      <p className="text-sm text-muted">Schulnetz-Bereiche, Stichtag der Zwei-Faktor-Pflicht und Abmeldung nach Inaktivität.</p>
    </Card>
  );
  const geraeteCard = (
    <Card aria-label="Gerätezertifikate">
      <CardHeader title="Gerätezertifikate" action={{ href: "/verwaltung/system/geraete", label: "Verwalten" }} />
      <p className="text-sm text-muted">
        Personal von außerhalb des Schulnetzes nur auf freigegebenen Geräten: Schul-CA, Ausstellung für das MDM, Sperrliste und die
        Regeln für Verwaltung/Admin von außen.
      </p>
    </Card>
  );

  // P4-72: Virenscan der Uploads (optional, Profil „clamav“)
  let scan: { state: "aus" | "bereit" | "fehler"; text: string };
  try {
    const target = clamavTarget(process.env);
    scan = target ? { state: "bereit", text: await clamavVersion(target) } : { state: "aus", text: "" };
  } catch (err) {
    scan = { state: "fehler", text: err instanceof Error ? err.message : String(err) };
  }
  const scanCard = (
    <Card aria-label="Virenscan">
      <CardHeader title="Virenscan" />
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={scan.state === "bereit" ? "success" : scan.state === "fehler" ? "danger" : "neutral"}>
          {scan.state === "bereit" ? "aktiv" : scan.state === "fehler" ? "nicht erreichbar" : "aus"}
        </Badge>
        <span className={scan.state === "bereit" ? "" : "text-muted"}>
          {scan.state === "bereit"
            ? `Uploads (Dateien, Aufgaben, Gebäude-Fotos, Prüfprotokolle) werden vor dem Speichern geprüft – ${scan.text}`
            : scan.state === "fehler"
              ? `${scan.text} – solange werden Uploads abgelehnt.`
              : "Optional: ClamAV als Compose-Profil „clamav“ und SCHULOS_CLAMAV=clamav:3310 in .env (INSTALLATION.md §5)."}
        </span>
      </p>
    </Card>
  );

  // SEC-15: Angriffserkennung (optional, Profil „crowdsec“)
  const cs = crowdsecConfig(process.env);
  const csState = cs ? await crowdsecStatus(cs) : null;
  const crowdsecCard = (
    <Card aria-label="Angriffserkennung">
      <CardHeader title="Angriffserkennung (CrowdSec)" />
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={!csState ? "neutral" : csState.ok ? "success" : "danger"}>{!csState ? "aus" : csState.ok ? "aktiv" : "nicht erreichbar"}</Badge>
        <span className={csState?.ok ? "" : "text-muted"}>
          {!csState
            ? "Optional: Compose-Profil „crowdsec“ – erkennt Angriffe im Zugriffsprotokoll und sperrt die Absender (ohne Weitergabe an die Community-Liste, INSTALLATION.md §5)."
            : csState.ok
              ? `${csState.active} ${csState.active === 1 ? "Adresse" : "Adressen"} gerade gesperrt. Einzelheiten: docker compose exec crowdsec cscli decisions list`
              : `${csState.error} – Sperren gelten mit dem letzten Stand weiter, bis sie ablaufen.`}
        </span>
      </p>
    </Card>
  );

  if (!status)
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Verwaltung" title="System" />
        <DisclaimerCard />
        <p role="status" className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
          <strong>Noch kein Systemstatus.</strong> Den schreibt <code>schulosctl system-sync</code> auf dem Server (systemd-Timer
          <code> schulos-sync.timer</code>, alle 5 Minuten). In der Entwicklung ohne Server bleibt diese Seite leer.
        </p>
        {backupCard}
        {mailCard}
        {anmeldungCard}
        {geraeteCard}
        {scanCard}
        {crowdsecCard}
        {queryStats}
      </main>
    );

  const up = status.update;
  const target = up?.status === "verfügbar" ? up.steps.at(-1)!.version : null;
  const os = status.os;
  const osState = os ? osSupportState(os) : null;
  const rebootDays = status.reboot ? rebootPendingDays(status.reboot) : 0;
  const rebootRed = rebootDays >= REBOOT_RED_DAYS;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="System" />
      <DisclaimerCard />

      {statusIsStale(status) && (
        <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          Stand vom {fmt.format(new Date(status.checkedAt))} – der Abgleich mit dem Server läuft offenbar nicht (Timer
          <code> schulos-sync.timer</code> prüfen).
        </p>
      )}
      {status.error && (
        <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          {status.error}
        </p>
      )}

      {superuser && (
        <Card aria-label="Datenbankrolle">
          <CardHeader title="Datenbankrolle umstellen" />
          <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
            SchulOS meldet sich noch mit Superuser-Recht an der Datenbank an. Seit Version 0.3.2 arbeitet die App ohne dieses Recht
            (Schutz bei Fehlern in der App). Installationen bis 0.3.1 brauchen dafür einmal ein neues <code>schulosctl</code> – Anleitung:
            INSTALLATION.md §5a.2 „Umstellung älterer Installationen“. Danach erledigt <code>schulosctl update</code> alles selbst.
          </p>
        </Card>
      )}

      {status.reboot && (
        <Card aria-label="Neustart nötig">
          <CardHeader title="Neustart nötig" />
          <div className="flex flex-col gap-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={rebootRed ? "danger" : "warn"}>{rebootRed ? `seit ${rebootDays} Tagen überfällig` : "Passphrase erforderlich"}</Badge>
              <span>
                Debian-Updates warten seit {fmt.format(new Date(status.reboot.since))} auf einen Neustart
                {rebootDays > 0 ? ` (${rebootDays} ${rebootDays === 1 ? "Tag" : "Tage"})` : ""}.
              </span>
            </p>
            <p className={rebootRed ? "text-danger" : "text-muted"}>
              Die Platte wird beim Start per Passphrase entsperrt – deshalb startet das Wartungsfenster den Server nicht selbst neu (er
              bliebe nachts an der Passphrase stehen). Bitte zu einer Zeit neu starten, in der jemand an der Konsole die Passphrase eingeben
              kann; vorher sichert SchulOS automatisch. Mit TPM2 startet der Server im Wartungsfenster selbst neu.
            </p>
            {order?.action === "neustart" ? (
              <p role="status" className="text-muted">
                Neustart beauftragt – der Server sichert und startet beim nächsten Abgleich neu.
              </p>
            ) : (
              <RebootForm />
            )}
          </div>
        </Card>
      )}

      {status.tpm && status.tpm.problems.length > 0 && (
        <Card aria-label="TPM-Bindung">
          <CardHeader title="TPM-Bindung der Platte unvollständig" />
          <div className="flex flex-col gap-2 text-sm">
            <ul className="list-disc pl-5">
              {status.tpm.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="text-muted">
              Solange die Platte nur an PCR 7 gebunden ist, entsperrt sie auch ein fremdes, von Debian signiertes Startmedium – der Schutz bei
              physischem Zugriff (SEC-09) greift dann nicht. Einzelheiten: INSTALLATION.md §2.3.
            </p>
          </div>
        </Card>
      )}

      <Card aria-label="Version">
        <CardHeader title="SchulOS" />
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Version</dt>
          <dd className="font-semibold">{status.current}</dd>
          <dt className="text-muted">Geprüft</dt>
          <dd>{fmt.format(new Date(status.checkedAt))}</dd>
        </dl>
        <ChannelForm channel={status.channel} />
        <p className="mt-2 text-sm text-muted">
          Fehlerbehebungen und Sicherheitsupdates spielt SchulOS im Wartungsfenster selbst ein; neue Funktionen erst nach Freigabe. Neue
          Module kommen ausgeschaltet und werden unter „Rechte &amp; Module“ eingeschaltet.
        </p>
      </Card>

      <Card aria-label="Updates">
        <CardHeader title="Updates" />
        {!up && <p className="text-sm text-muted">Unbekannt – die Update-Quelle war nicht erreichbar.</p>}
        {up?.status === "aktuell" && (
          <p className="text-sm">
            <Badge tone="success">aktuell</Badge> Keine neuere Version im Kanal „{status.channel}“.
          </p>
        )}
        {up?.status === "blockiert" && (
          <p role="alert" className="text-sm text-danger">
            {up.reason}
          </p>
        )}
        {up?.status === "verfügbar" && target && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">SchulOS {target} verfügbar</span>
              <Badge tone="soft">{KIND_LABEL[up.kind]}</Badge>
              {up.securityRelevant && <Badge tone="danger">sicherheitsrelevant</Badge>}
            </div>
            {up.steps.length > 1 && (
              <p className="text-sm text-muted">Weg: {[status.current, ...up.steps.map((s) => s.version)].join(" → ")} (Zwischenversionen werden nacheinander installiert)</p>
            )}
            {up.steps.map((s) => (
              <section key={s.version} aria-label={`Änderungen in ${s.version}`} className="text-sm">
                <h3 className="mb-1 font-semibold">
                  {s.version} <span className="font-normal text-muted">· {day.format(new Date(s.publishedAt))}</span>
                </h3>
                <ul className="flex flex-col gap-1">
                  {s.changes.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge tone={c.kind === "sicherheit" ? "danger" : c.kind === "neu" ? "soft" : "neutral"}>{CHANGE_LABEL[c.kind]}</Badge>
                      <span>{c.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {status.approved?.version === target ? (
              <p role="status" className="text-sm">
                <Badge tone="success">freigegeben</Badge> Wird im nächsten Wartungsfenster installiert.
              </p>
            ) : up.kind === "patch" ? (
              <p className="text-sm text-muted">Fehlerbehebung – wird im nächsten Wartungsfenster ohne Freigabe installiert.</p>
            ) : (
              <ReleaseForm target={target} />
            )}
            <p className="text-sm text-muted">
              Ablauf: Sicherung → Probelauf auf einer Kopie der Daten (danach gelöscht) → Update → Prüfung; schlägt etwas fehl, läuft die
              bisherige Version mit dem Datenstand von vorher weiter.
            </p>
          </div>
        )}
        {order && (
          <p role="status" className="mt-3 text-sm text-muted">
            Auftrag vom {fmt.format(new Date(order.createdAt))} wartet auf den nächsten Abgleich (
            {order.action === "kanal" ? `Kanal ${order.channel}` : order.action === "neustart" ? "Neustart" : `Freigabe ${order.target}`}).
          </p>
        )}
      </Card>

      {backupCard}
      {mailCard}
      {anmeldungCard}
      {geraeteCard}
      {scanCard}
      {crowdsecCard}

      <Card aria-label="Betriebssystem">
        <CardHeader title="Betriebssystem" />
        {os && osState ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{os.name}</span>
              <Badge tone={OS_TEXT[osState].tone}>{OS_TEXT[osState].label}</Badge>
            </div>
            {os.securityUntil && (
              <p>
                Sicherheitsupdates bis voraussichtlich {day.format(new Date(os.securityUntil))}
                {os.ltsUntil && `, Langzeit-Support bis ${day.format(new Date(os.ltsUntil))}`}.
              </p>
            )}
            {(osState === "wechsel-empfohlen" || osState === "nur-lts" || osState === "abgelaufen") && (
              <p className="text-warn">
                Versionswechsel planen: <code>schulosctl os-upgrade</code> (mit Schnappschuss und automatischem Rückweg) oder Neuinstallation und
                Wiederherstellung aus dem Backup.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Unbekannt (kein Debian-Server).</p>
        )}
      </Card>

      <section aria-label="Update-Protokoll" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Protokoll</h2>
        {status.protocol.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Updates oder Prüfungen.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Schritt</th>
                <th>Version</th>
                <th>Ergebnis</th>
              </tr>
            </thead>
            <tbody>
              {status.protocol.map((e, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-muted tabular-nums">{fmt.format(new Date(e.at))}</td>
                  <td className="font-medium">{PROTOCOL_STEP_LABEL[e.step] ?? e.step}</td>
                  <td className="whitespace-nowrap">{e.from && e.to ? `${e.from} → ${e.to}` : (e.to ?? "")}</td>
                  <td>
                    <Badge tone={e.ok ? "success" : "danger"}>{e.ok ? "ok" : "Fehler"}</Badge>
                    {e.detail && <span className="ml-2 text-muted">{e.detail}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      {queryStats}
    </main>
  );
}
