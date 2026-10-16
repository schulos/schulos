import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditLog, users } from "@/db/schema";

/** Eintrag ins Protokoll. `action` im Format "<bereich>.<vorgang>", z. B. "konto.anmeldung". */
export async function audit(db: Db, actorId: string | null, action: string, target?: string | null, meta?: Record<string, unknown>) {
  await db.insert(auditLog).values({ actorId, action, target: target ?? null, meta: meta ?? null });
}

/** Deutsche Beschriftungen der Protokoll-Aktionen. */
export const AUDIT_LABELS: Record<string, string> = {
  "system.erststart": "Erststart: Admin-Konto angelegt",
  "konto.anmeldung": "Anmeldung",
  "konto.anmeldung.gesperrt": "Anmeldung vorübergehend gesperrt",
  "konto.2fa.eingerichtet": "Zwei-Faktor-Anmeldung eingerichtet",
  "konto.2fa.codes": "Neue Wiederherstellungscodes",
  "kopplung.code_erzeugt": "Kopplungscode erzeugt",
  "kopplung.code_zurueckgezogen": "Kopplungscode zurückgezogen",
  "kopplung.gekoppelt": "Hauptsystem gekoppelt",
  "kopplung.ersatzcode_erzeugt": "Ersatz-Kopplungscode erzeugt (neue Hardware)",
  "kopplung.ersatz": "Instanz von neuer Hardware übernommen",
  "instanz.umbenannt": "Instanz umbenannt",
  "instanz.entkoppelt": "Instanz entkoppelt",
  "sicherung.angefordert": "Sicherung angefordert (Jetzt sichern)",
  "instanz.zeitplan": "Zeitplan geändert",
  "instanz.aufbewahrung": "Aufbewahrung geändert",
  "instanz.aufgeraeumt": "Aufgeräumt (von Hand)",
  "konto.angelegt": "Konto angelegt",
  "wiederherstellung.angefordert": "Wiederherstellung angefordert",
  "wiederherstellung.bestaetigt": "Wiederherstellung im Hauptsystem bestätigt",
  "wiederherstellung.verworfen": "Wiederherstellung verworfen (falsche Codes)",
  "wiederherstellung.abgelehnt": "Wiederherstellung abgelehnt bzw. abgebrochen",
  "wiederherstellung.fertig": "Wiederherstellung abgeschlossen",
  "wiederherstellung.fehlgeschlagen": "Wiederherstellung fehlgeschlagen",
  "konto.gesperrt": "Konto gesperrt",
  "konto.entsperrt": "Konto entsperrt",
  "konto.2fa_zurueckgesetzt": "Zwei-Faktor zurückgesetzt",
  "konto.passwort_zurueckgesetzt": "Startpasswort neu vergeben",
  "konto.passwort_geaendert": "Eigenes Passwort geändert",
};

export function auditLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action;
}

export async function recentAudit(db: Db, limit = 200) {
  return db
    .select({ id: auditLog.id, createdAt: auditLog.createdAt, action: auditLog.action, target: auditLog.target, meta: auditLog.meta, actor: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}
