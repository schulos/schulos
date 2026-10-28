// Zeitplan der Hintergrundjobs (B-17). Gestartet aus src/core/startup.ts, wenn jobsEnabled().
import type { Db } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { runExclusive, tick, type ScheduledJob } from "@/core/jobs";
import { deliverWithConfig, mailAvailable, transportConfig } from "@/core/mail";
import { pruneRateLimits } from "@/core/rate-limit";
import { runDeletion } from "@/core/privacy/loeschlauf";
import { toBerlinDate } from "@/core/time";
import { holidayAutoEnabled, syncHolidays } from "@/modules/verwaltung/ferien-abruf";
import { readSchoolSettings } from "@/core/settings";
import { runAlarms } from "@/core/system/alarms";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { safeMailConfig } from "@schulos/server/mail";
import { MODULES } from "@/modules";
import { runInspectionReminders } from "@/modules/gebaeude/pruefungen";
import { purgeUnconfirmed } from "@/modules/anmeldung/public";
import { runGapReminders } from "@/modules/klassenbuch/luecken";
import { runPrefWindowReminders } from "@/modules/stundenplan/zeitwunsch-fenster";
import { runSprechtagReminders } from "@/modules/sprechtag/erinnerung";
import { runKurswahlReminders } from "@/modules/kurswahl/erinnerung";
import { runReviewReminders } from "@/modules/hilfe/service";
import { purgeExpiredOfflineDevices } from "@/modules/notenbuch/offline";
import { runReservations } from "@/modules/buecherei/reservations";
import { runSchoolbookDunning } from "@/modules/buecherei/ausgabe";
import { runDunning } from "@/modules/buecherei/mahnungen";
import { cleanupRuns, executeQueued } from "@/modules/stundenplan/solverlauf";
import { cleanupVersions } from "@/modules/stundenplan/planversionen";
import { runSubstitutionQueue } from "@/modules/stundenplan/benachrichtigung";
import { runPlanNotifications } from "@/modules/stundenplan/veroeffentlichen";
import { runPlanChangeNotifications } from "@/modules/stundenplan/sofortkorrektur";

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    // Löschlauf nach Löschkonzept (DATENSCHUTZ.md §3), Protokoll ohne auslösende Person = nächtlicher Lauf
    name: "loeschlauf",
    at: "02:30",
    until: "06:00",
    ttlMs: 2 * 60 * 60_000,
    run: (db, now) => runDeletion(db, null, toBerlinDate(now), { storage: getStorage(), now }),
  },
  {
    // G5A-S06: Server-Anteile der Offline-Eingabe nach Fristablauf löschen (spätestens 7 Tage; nach Entzug „nur noch
    // Übertragen“ bis zum nächsten Lauf) – auch wenn das Gerät das Notenbuch nie wieder öffnet. Läuft unabhängig vom Modulschalter.
    name: "notenbuch-offline-frist",
    at: "02:45",
    until: "06:00",
    ttlMs: 10 * 60_000,
    run: (db, now) => purgeExpiredOfflineDevices(db, now),
  },
  {
    // Ferien des eingestellten Bundeslandes (OpenHolidays API); ohne Internet bleibt alles, wie es ist
    name: "ferien",
    at: "03:30",
    until: "06:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      if (!(await holidayAutoEnabled(db))) return;
      const s = await syncHolidays(db, toBerlinDate(now));
      if (!s.ok) throw new Error(s.error);
    },
  },
  {
    // Prüffristen (P4-16): bald fällig → Gong wöchentlich, überfällig → täglich Gong + Alarm-Mail; nur bei eingeschaltetem Modul
    name: "gebaeude-fristen",
    at: "04:00",
    until: "06:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "gebaeude");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      const config = safeMailConfig();
      const name = (await readSchoolSettings(db)).name;
      const r = await runInspectionReminders(db, { now, mail: { config, server: `SchulOS ${name}` } });
      // Gong ist raus; eine gescheiterte Alarm-Mail macht den Lauf sichtbar rot (Systemstatus), statt still zu verschwinden
      if (r.mailError) throw new Error(`Alarm-Mail zu überfälligen Prüfungen fehlgeschlagen: ${r.mailError}`);
      return r;
    },
  },
  {
    // Q5-06: freitags nach dem Unterricht je Lehrkraft ein Gong „n Stunden ohne Eintrag“ (nur für die Person selbst)
    name: "klassenbuch-luecken",
    at: "15:30",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "klassenbuch");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runGapReminders(db, now);
    },
  },
  {
    // Q5-10: Eingabefenster für Zeitwünsche – Gong am ersten Tag an alle Lehrkräfte, kurz vor der Frist an die ohne Abgabe
    name: "zeitwuensche-frist",
    at: "07:00",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "stundenplan");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runPrefWindowReminders(db, now);
    },
  },
  {
    // P4-52: Elternsprechtag morgen → ein Gong je Familie und Lehrkraft mit den eigenen Terminen, Mail an bestätigte Adressen
    name: "sprechtag-erinnerung",
    at: "15:00",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "sprechtag");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runSprechtagReminders(db, now, { mail: mailAvailable(), school: (await readSchoolSettings(db)).name });
    },
  },
  {
    // P4-66: Kurswahl endet in zwei Tagen → einmal je Verfahren ein Gong an alle, die noch wählen bzw. bestätigen müssen (keine Mail)
    name: "kurswahl-erinnerung",
    at: "16:00",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "kurswahl");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runKurswahlReminders(db, now);
    },
  },
  {
    // HB-04: Handbuchseiten nach der eingestellten Frist (Vorgabe 12 Monate, abschaltbar) – einmal ein Gong an die Ansprechperson
    name: "hilfe-ueberpruefung",
    at: "07:15",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "hilfe");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runReviewReminders(db, now);
    },
  },
  {
    // SP-06 (Q-SP-11): Solver-Läufe aufräumen – fehlgeschlagene/abgebrochene ohne Ergebnis nach 7 Tagen weg, je Schuljahr nur
    // die neuesten 20 fertigen Läufe mit vollem Ergebnis (ältere behalten Kennzahlen und Protokoll); LK-90 macht der Löschlauf.
    // SP3-01: dazu Planversionen – Rücknahme-Daten ab dem Stichtag leeren, offene Entwürfe abgelaufener Schuljahre verwerfen, „Bestand 1.0“
    name: "solver-aufraeumen",
    at: "03:00",
    until: "06:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => ({ ...(await cleanupRuns(db, now)), versions: await cleanupVersions(db, now) }),
  },
  {
    // BU-03: verfallene Abholfristen von Vormerkungen löschen, nächste Vormerkung nachrücken lassen (Gong)
    name: "buecherei-vormerkungen",
    at: "06:30",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "buecherei");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      return runReservations(db, toBerlinDate(now));
    },
  },
  {
    // BU-04: Erinnerung vor Fristende, Mahnstufen 1–3 (nur an Schultagen; Eltern Minderjähriger ab Stufe 2; Mail optional); BU-11: Schulbücher
    name: "buecherei-mahnungen",
    at: "06:45",
    until: "20:00",
    ttlMs: 10 * 60_000,
    run: async (db, now) => {
      const m = MODULES.find((x) => x.id === "buecherei");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      const opts = { mail: mailAvailable(), school: (await readSchoolSettings(db)).name };
      const library = await runDunning(db, toBerlinDate(now), opts, now);
      // BU-11: nicht zurückgegebene Schulbücher (nur mit eingeschalteter Schulbuchausleihe; Eltern Minderjähriger ab Stufe 1)
      return { ...library, schoolbooks: await runSchoolbookDunning(db, toBerlinDate(now), opts, now) };
    },
  },
];

const g = globalThis as unknown as { __schulosScheduler?: NodeJS.Timeout };

/** Prüft jede Minute, ob ein Job fällig ist. Mehrfacher Aufruf (Hot-Reload) startet keinen zweiten Takt. */
export function startScheduler(db: Db, jobs: readonly ScheduledJob[] = SCHEDULED_JOBS, everyMs = 60_000): void {
  if (g.__schulosScheduler) return;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const r of await tick(db, jobs)) {
        if (r.error) console.error(`[schulos] Job ${r.name} fehlgeschlagen: ${r.error}`);
        else console.log(`[schulos] Job ${r.name} gelaufen`);
      }
    } catch (err) {
      console.error("[schulos] Job-Takt fehlgeschlagen:", err);
    } finally {
      busy = false;
    }
  };
  g.__schulosScheduler = setInterval(run, everyMs);
  g.__schulosScheduler.unref();
  void run();
}

const gq = globalThis as unknown as { __schulosSolverQueue?: NodeJS.Timeout };

/**
 * Warteschlange der Solver-Läufe (SP-06): alle 30 s nachsehen, ob ein Lauf wartet, den kein Prozess rechnet – nach einem
 * Neustart, wenn ein anderer Prozess die Sperre hielt, oder wenn der Start aus der Anfrage verloren ging. Verwaiste
 * Läufe ohne Lebenszeichen werden dabei als fehlgeschlagen markiert. Normalerweise startet die Server Action den Lauf direkt.
 */
export function startSolverQueue(db: Db, everyMs = 30_000): void {
  if (gq.__schulosSolverQueue) return;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await executeQueued(db, toBerlinDate(new Date()));
      if (r.executed.length) console.log(`[schulos] Stundenplan-Berechnung aus der Warteschlange gerechnet: ${r.executed.length}`);
    } catch (err) {
      console.error("[schulos] Solver-Warteschlange fehlgeschlagen:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  gq.__schulosSolverQueue = setInterval(run, everyMs);
  gq.__schulosSolverQueue.unref();
  void run();
}

const ga = globalThis as unknown as { __schulosAlarms?: NodeJS.Timeout };

/** Alarm-Mails (B-38) alle 15 Minuten prüfen – nur mit SMTP-Konfiguration; Fehler beim Senden werden geloggt. */
export function startAlarmChecks(db: Db, everyMs = 15 * 60_000): void {
  if (ga.__schulosAlarms) return;
  const run = async () => {
    try {
      const name = (await readSchoolSettings(db)).name;
      const r = await runAlarms(db, { server: `SchulOS ${name}` });
      if (r.sent) console.log(`[schulos] Alarm-Mail gesendet (${r.alarms?.join(", ") || "behoben"})`);
    } catch (err) {
      console.error("[schulos] Alarm-Mail fehlgeschlagen:", err instanceof Error ? err.message : err);
    }
  };
  ga.__schulosAlarms = setInterval(run, everyMs);
  ga.__schulosAlarms.unref();
  void run();
}

const gv = globalThis as unknown as { __schulosSubstitutionGong?: NodeJS.Timeout };

/**
 * VT-04: Vertretungsnachrichten zur geplanten Zeit (Vortags-Uhrzeit, Ende der Ruhezeit) – jede Minute unter der Sperre
 * „vertretung-gong“, damit zwei App-Prozesse nicht gleichzeitig takten (doppelt senden verhindert zusätzlich die Tagessperre).
 * Nur bei eingeschaltetem Stundenplan-Modul; Fälliges von vorher geht nach dem Einschalten raus.
 */
export function startSubstitutionGong(db: Db, everyMs = 60_000): void {
  if (gv.__schulosSubstitutionGong) return;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const m = MODULES.find((x) => x.id === "stundenplan");
      if (!m || !isEnabled(m, await loadModuleStates(db))) return;
      // SP3-04: im selben Takt die Änderungslisten veröffentlichter Planversionen an Schüler:innen/Eltern (Vortags-Uhrzeit),
      // SP3-05: ebenso die der Sofort-Korrekturen im gültigen Plan
      const r = await runExclusive(
        db,
        "vertretung-gong",
        async () => {
          const now = new Date();
          return { ...(await runSubstitutionQueue(db, now)), plans: await runPlanNotifications(db, now), corrections: await runPlanChangeNotifications(db, now) };
        },
        { ttlMs: 5 * 60_000 },
      );
      if (r.error) console.error(`[schulos] Vertretungsnachrichten fehlgeschlagen: ${r.error}`);
      else if (r.result?.sent) console.log(`[schulos] Vertretungsnachrichten: ${r.result.sent} gesendet (${r.result.days} Tage)`);
      if (r.result?.plans) console.log(`[schulos] Änderungslisten neuer Stundenpläne: ${r.result.plans} gesendet`);
    } catch (err) {
      console.error("[schulos] Vertretungsnachrichten fehlgeschlagen:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  gv.__schulosSubstitutionGong = setInterval(run, everyMs);
  gv.__schulosSubstitutionGong.unref();
  void run();
}

const gm = globalThis as unknown as { __schulosMailOutbox?: NodeJS.Timeout };

/**
 * Transaktionsmails (P4-30): jede Minute die Warteschlange abarbeiten – unter einer DB-Sperre („mail-outbox“), damit zwei
 * App-Prozesse nichts doppelt senden. Ohne SMTP-Konfiguration passiert nichts (Mails bleiben liegen, /dev/mail in Dev/E2E).
 */
export function startMailOutbox(db: Db, everyMs = 60_000): void {
  if (gm.__schulosMailOutbox) return;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      // abgelaufene Rate-Limit-Zähler (P4-31) gleich mit wegräumen – leicht, unabhängig vom SMTP
      await pruneRateLimits(db);
      // Schulanmeldung (P4-35): unbestätigte Anträge nach 48 h vollständig löschen – auch bei ausgeschaltetem Modul
      const purged = await purgeUnconfirmed(db);
      if (purged) console.log(`[schulos] Schulanmeldung: ${purged} unbestätigte Anträge gelöscht`);
      const cfg = transportConfig();
      if (!cfg) return;
      const r = await runExclusive(db, "mail-outbox", () => deliverWithConfig(db, new Date(), cfg), { ttlMs: 5 * 60_000 });
      if (r.error) console.error(`[schulos] Mailversand fehlgeschlagen: ${r.error}`);
      else if (r.result && (r.result.sent || r.result.failed))
        console.log(`[schulos] Mails: ${r.result.sent} gesendet, ${r.result.retry} später erneut, ${r.result.failed} endgültig gescheitert`);
    } catch (err) {
      console.error("[schulos] Mail-Warteschlange fehlgeschlagen:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  gm.__schulosMailOutbox = setInterval(run, everyMs);
  gm.__schulosMailOutbox.unref();
  void run();
}
