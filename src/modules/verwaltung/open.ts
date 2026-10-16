// „Offen für dich“ (Q5-07, I-27): Backup-Ampel für alle mit dem Systemrecht – wie der Hinweis auf der Verwaltungsseite nur bei
// fehlgeschlagener, überfälliger oder fehlender Sicherung, nicht in der Demo (fiktive Daten). DS-12: Hinweis auf die
// unvollständige Datenschutz-Einrichtung für alle mit dem Datenschutzrecht.
import { backupStatus, needsAttention, type BackupStatus } from "@/core/backup/status";
import { hasPermission, isDemoDb } from "@/core/permissions";
import type { OpenItem, OpenItemsProvider } from "@/core/open-items";
import { readSetup, type SetupState } from "@/core/privacy/einrichtung";

/** Rein: Punkt für die Backup-Ampel (oder keiner). */
export function backupItem(s: BackupStatus): OpenItem | null {
  if (!needsAttention(s)) return null;
  return {
    id: "verwaltung:backup",
    moduleId: "verwaltung",
    label: !s.paired ? "Keine Sicherung eingerichtet" : s.health === "failed" ? "Sicherung fehlgeschlagen" : "Sicherung überfällig",
    detail: s.paired ? (s.lastOkAt ? "letzte erfolgreiche Sicherung ist zu alt bzw. danach schiefgegangen" : "noch keine erfolgreiche Sicherung") : "ohne Backupserver gehen bei einem Plattenschaden alle Daten verloren",
    href: "/verwaltung/backup",
    tone: "danger",
  };
}

/** Rein (DS-12): Hinweis, solange die Datenschutz-Einrichtung nicht abgeschlossen ist. */
export function privacySetupItem(s: Pick<SetupState, "confirmed" | "open" | "done">): OpenItem | null {
  if (s.done) return null;
  const topics = s.open - (s.confirmed ? 0 : 1);
  return {
    id: "verwaltung:datenschutz",
    moduleId: "verwaltung",
    label: s.confirmed ? "Datenschutz-Einrichtung unvollständig" : "Datenschutz-Einrichtung durch die Schule",
    detail: s.confirmed
      ? `${topics} ${topics === 1 ? "Punkt" : "Punkte"} der DSB-Checkliste offen`
      : "Bestätigung als Verantwortliche und Benennung der bzw. des DSB fehlen",
    href: "/verwaltung/datenschutz/einrichtung",
    tone: "warn",
  };
}

export function verwaltungOpen(status: () => BackupStatus = () => backupStatus()): OpenItemsProvider {
  return {
    moduleId: "verwaltung",
    async collect(db, { perms }) {
      const items: OpenItem[] = [];
      if (hasPermission(perms, "verwaltung.system") && !(await isDemoDb(db))) {
        const item = backupItem(status());
        if (item) items.push(item);
      }
      // DS-12: auch in der Demo – die Einrichtung ist dort Teil der Vorführung
      if (hasPermission(perms, "verwaltung.privacy")) {
        const item = privacySetupItem(await readSetup(db));
        if (item) items.push(item);
      }
      return items;
    },
  };
}
