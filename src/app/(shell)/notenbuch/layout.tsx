import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { gradeOwners } from "@/modules/notenbuch/einsicht";
import { notenbuchActivity, sessionHasSecondFactor } from "@/modules/notenbuch/guard";
import { NOTICE_POINTS, NOTICE_TITLE, noticeAcknowledged } from "@/modules/notenbuch/hinweis";
import { notenbuchAccess, TWO_FACTOR_SETUP_HREF } from "@/modules/notenbuch/service";
import { IDLE_MINUTES } from "@/modules/notenbuch/sitzung";
import { NotenbuchLocked } from "./gesperrt";
import { NotenbuchNotice } from "./hinweis";
import { IdleGuard } from "./sperre";

/**
 * Notenbuch (P5-11/P5-12): Modul aus → 404; ohne Recht bzw. Klassenleitung → 404 (auch Admin-Konten), außer der
 * Schüler-/Elternsicht (P5-14, nur `/notenbuch`, Unterseiten prüfen selbst); ohne eingerichtete
 * Zwei-Faktor-Anmeldung → Weiterleitung zur Einrichtung (F5-07). Nach 15 Minuten ohne Aktivität nur noch die Sperre (P5-12) –
 * jede Seite prüft das zusätzlich selbst (`notenbuchPageLocked`), weil das Layout bei Wechseln innerhalb des Bereichs nicht neu läuft.
 * P5-17: vor der ersten Nutzung nur der Datenschutzhinweis (ohne Daten, ohne Aktivität im Notenbuch), bis die Person ihn bestätigt.
 */
export default async function NotenbuchLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("notenbuch");
  const { perms } = await requireUser();
  const db = await getDb();
  const access = await notenbuchAccess(db, perms);
  if (!access.any) {
    // P5-14: Schüler-/Elternsicht (nur eigene Noten, nach Moduleinstellung) – ohne 2FA-Pflicht und Inaktivitätsablauf (Q-5A-16)
    if ((await gradeOwners(db, perms)).length) return children;
    notFound();
  }
  if (!access.twoFactor) redirect(TWO_FACTOR_SETUP_HREF);
  // G5A-S04: die Sitzung selbst muss mit Code angemeldet sein – vor dem Hinweis (gehört zur Zwei-Faktor-Stufe)
  if (!(await sessionHasSecondFactor(db, perms.userId))) return <NotenbuchLocked reason="zweiter-faktor" />;
  if (!(await noticeAcknowledged(db, perms.userId))) return <NotenbuchNotice title={NOTICE_TITLE} points={NOTICE_POINTS} />;
  const gate = await notenbuchActivity(db, perms.userId);
  if (gate !== "ok") return <NotenbuchLocked reason={gate} />;
  return <IdleGuard minutes={IDLE_MINUTES}>{children}</IdleGuard>;
}
