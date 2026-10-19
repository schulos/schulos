import type { Metadata } from "next";
import Link from "next/link";
import { count } from "drizzle-orm";
import { ArrowRight } from "lucide-react";
import { lockedLogins } from "@/core/auth/sperre";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission, isDemoDb } from "@/core/permissions";
import { backupStatus, needsAttention } from "@/core/backup/status";
import { TZ } from "@/core/time";
import { unlockLoginAction } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { groups } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { releaseNote } from "@/core/school/freigabe";
import { getSchoolSettings } from "@/core/settings";
import { countByRole } from "@/modules/verwaltung/users";
import { ROLES } from "@/core/db/schema";
import { PageHeader } from "@schulos/ui/misc";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import notenbuchModule from "@/modules/notenbuch/manifest";
import { hasNotenbuchRight, orphanedBooks, TRANSFER } from "@/modules/notenbuch/service";
import stundenplanModule from "@/modules/stundenplan/manifest";
import { PLAN_MANAGE, PLAN_SUBSTITUTE } from "@/modules/stundenplan/rechte";

export const metadata: Metadata = { title: "Verwaltung" };

const timeFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: TZ });
const timeFmtLong = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function VerwaltungPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [byRole, [g], school, locked, demo, moduleStates] = await Promise.all([
    countByRole(db),
    db.select({ n: count() }).from(groups),
    getSchoolSettings(),
    hasPermission(perms, "verwaltung.users") ? lockedLogins(db) : [],
    isDemoDb(db),
    loadModuleStates(db),
  ]);
  // SP-04: Die Planung liegt seit SP-03 unter /planung – Einstieg von hier, wenn ein Planungsrecht vorhanden ist
  const planning = (hasPermission(perms, PLAN_MANAGE) || hasPermission(perms, PLAN_SUBSTITUTE)) && isEnabled(stundenplanModule, moduleStates);
  // P5-15: verwaiste Notenbücher (keine aktive Lehrkraft) – nur Gruppe/Fach, für Benutzerverwaltung und „Übertragen“
  const canTransfer = hasNotenbuchRight(perms, TRANSFER);
  const orphans =
    (hasPermission(perms, "verwaltung.users") || canTransfer) && isEnabled(notenbuchModule, moduleStates) ? await orphanedBooks(db) : [];
  // Sicherung: nur für das Systemrecht und nicht in Demo-Instanzen (fiktive Daten)
  const backup = hasPermission(perms, "verwaltung.system") && !demo ? backupStatus() : null;
  return (
    <main className="flex flex-col gap-7">
      <PageHeader eyebrow="Verwaltung" title={school.name} />
      <section aria-label="Kennzahlen" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {ROLES.map((r) => (
          <Link
            key={r}
            href={`/verwaltung/benutzer?role=${r}`}
            className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong"
          >
            <span className="text-sm text-muted">{ROLE_LABELS[r]}</span>
            <span className="font-display text-3xl font-bold tracking-tight">{byRole[r]}</span>
          </Link>
        ))}
        <Link
          href="/verwaltung/gruppen"
          className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong"
        >
          <span className="text-sm text-muted">Gruppen</span>
          <span className="font-display text-3xl font-bold tracking-tight">{g?.n ?? 0}</span>
        </Link>
        {planning && (
          <Link
            href="/planung"
            className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong"
          >
            <span className="text-sm text-muted">Stundenplanung</span>
            <span className="inline-flex items-center gap-1 font-semibold text-accent-ink">
              öffnen <ArrowRight aria-hidden className="size-4" />
            </span>
          </Link>
        )}
      </section>
      {backup && needsAttention(backup) && (
        <Card aria-label="Sicherung" className="border-danger">
          <CardHeader title={backup.paired ? "Sicherung fehlgeschlagen oder überfällig" : "Keine Sicherung eingerichtet"} />
          <p className="text-sm">
            {backup.paired
              ? backup.lastOkAt
                ? `Die letzte erfolgreiche Sicherung ist vom ${timeFmtLong.format(backup.lastOkAt)}.`
                : "Es gibt noch keine erfolgreiche Sicherung."
              : "Ohne gekoppelten Backupserver gehen bei einem Plattenschaden alle Daten verloren."}
          </p>
          <p className="text-sm">
            <Link href="/verwaltung/backup" className="font-medium hover:underline">
              Backup öffnen
            </Link>
          </p>
        </Card>
      )}
      {releaseNote(school.profile.state) && (
        <Card aria-label="Freigabe" className="border-warn">
          <CardHeader title="Bundesland nicht freigegeben" />
          <p className="text-sm">{releaseNote(school.profile.state)}</p>
          <p className="text-sm">
            <Link href="/verwaltung/schule" className="font-medium hover:underline">
              Schuleinstellungen öffnen
            </Link>
          </p>
        </Card>
      )}
      {orphans.length > 0 && (
        <Card aria-label="Verwaiste Notenbücher" className="border-warn">
          <CardHeader title={`Notenbücher ohne aktive Lehrkraft (${orphans.length})`} />
          <p className="text-sm text-muted">
            Die Lehrkraft ist ausgeschieden oder ihr Konto gesperrt bzw. gelöscht. Die Notenbücher gehören der Schule und bleiben erhalten – bitte an eine
            Lehrkraft übertragen (Recht „Übertragen“, z. B. Schulleitung; ohne Einsicht in Noten, protokolliert).
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {orphans.map((o) => (
              <li key={o.id}>
                {o.groupName} – {o.subjectName} · {o.schoolYearName} · {o.term}. Halbjahr
              </li>
            ))}
          </ul>
          {canTransfer && (
            <p className="text-sm">
              <Link href="/notenbuch#uebertragen" prefetch={false} className="font-medium hover:underline">
                Notenbücher übertragen
              </Link>
            </p>
          )}
        </Card>
      )}
      {locked.length > 0 && (
        <Card aria-label="Gesperrte Anmeldungen" className="border-warn">
          <CardHeader title={`Vorübergehend gesperrte Anmeldungen (${locked.length})`} />
          <p className="text-sm text-muted">
            Nach 5 falschen Passwörtern in 15 Minuten ist die Anmeldung für 15 Minuten gesperrt – auch für Benutzernamen, die es nicht gibt.
            Häufen sich unbekannte Namen, probiert vermutlich jemand Passwörter durch.
          </p>
          <ul className="flex flex-col gap-2">
            {locked.map((l) => (
              <li key={l.username} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0">
                <span>
                  {l.userId ? (
                    <Link href={`/verwaltung/benutzer/${encodeURIComponent(l.userId)}`} className="font-medium hover:underline">
                      {l.name}
                    </Link>
                  ) : (
                    <span className="font-medium">unbekannter Name „{l.username}“</span>
                  )}{" "}
                  <span className="text-muted">
                    · {l.failures} Fehlversuche · gesperrt bis {timeFmt.format(l.lockedUntil)} Uhr
                  </span>
                </span>
                {l.userId && (
                  <form action={unlockLoginAction}>
                    <input type="hidden" name="username" value={l.username} />
                    <Button type="submit" size="sm" aria-label={`Sperre ${l.name} aufheben`}>
                      Sperre aufheben
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
