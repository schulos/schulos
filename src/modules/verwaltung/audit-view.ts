// Lesende Sicht aufs Audit-Log: Aktionen beschriften, Ziele auflösen.
import { and, count, desc, eq, inArray, like, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { auditLog, groups, users } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { isPseudonym } from "@/core/privacy/protokoll";
import type { Role } from "@/core/roles";

export const AUDIT_PAGE_SIZE = 50;

export const ACTION_LABELS: Record<string, string> = {
  "verwaltung.user.create": "Benutzer angelegt",
  "verwaltung.user.update": "Benutzer geändert",
  "verwaltung.eltern.verknuepft": "Elternkonto mit Kind verknüpft",
  "verwaltung.eltern.geloest": "Verknüpfung Elternkonto – Kind gelöst",
  "verwaltung.user.lock": "Benutzer gesperrt",
  "verwaltung.user.unlock": "Benutzer entsperrt",
  "verwaltung.user.eigenstaendig": "Als eigenständig (volljährig) gekennzeichnet",
  "verwaltung.user.eigenstaendig_aus": "Kennzeichen „eigenständig“ entfernt",
  "konto.eltern_informieren.ein": "Einwilligung „Eltern weiter informieren“ erteilt",
  "konto.eltern_informieren.aus": "Einwilligung „Eltern weiter informieren“ widerrufen",
  "verwaltung.user.password_reset": "Passwort zurückgesetzt",
  "verwaltung.user.left": "Abgang eingetragen",
  "verwaltung.user.reactivate": "Abgang zurückgenommen",
  "verwaltung.group.create": "Gruppe angelegt",
  "verwaltung.group.update": "Gruppe geändert",
  "verwaltung.group.delete": "Gruppe gelöscht",
  "verwaltung.group.members_add": "Mitglieder hinzugefügt",
  "verwaltung.group.member_remove": "Mitglied entfernt",
  "verwaltung.group.member_role": "Leitung geändert",
  "verwaltung.group.feature": "Gruppenmerkmal geändert",
  "verwaltung.rights.grant": "Recht vergeben",
  "verwaltung.rights.revoke": "Recht entzogen",
  "verwaltung.module.enable": "Modul eingeschaltet",
  "verwaltung.module.disable": "Modul abgeschaltet",
  "verwaltung.import.students": "Schüler:innen importiert",
  "verwaltung.school.update": "Schuldaten geändert",
  "verwaltung.school.logo": "Schullogo geändert",
  "verwaltung.stammdaten.grades": "Jahrgänge geändert",
  "verwaltung.stammdaten.grades_template": "Jahrgänge aus Vorlage übernommen",
  "verwaltung.stammdaten.subjects": "Fächer geändert",
  "verwaltung.stammdaten.subject_move": "Fach verschoben",
  "verwaltung.stammdaten.subject_delete": "Fach gelöscht",
  "verwaltung.stammdaten.periods": "Zeitraster geändert",
  "verwaltung.stammdaten.period_add": "Stunde angehängt",
  "verwaltung.stammdaten.period_remove": "Stunde entfernt",
  "verwaltung.stammdaten.time_grid": "Zeitraster aus Vorlage übernommen",
  "verwaltung.stammdaten.curriculum": "Stundentafel geändert",
  "verwaltung.stammdaten.curriculum_template": "Stundentafel aus Vorlage übernommen",
  "verwaltung.stammdaten.school_years": "Schuljahre geändert",
  "verwaltung.stammdaten.school_year_add": "Schuljahr angelegt",
  "verwaltung.stammdaten.school_year_delete": "Schuljahr gelöscht",
  "verwaltung.stammdaten.closures": "Ferien geändert",
  "verwaltung.stammdaten.closure_delete": "Ferien gelöscht",
  "verwaltung.stammdaten.ferien_abruf": "Ferien abgerufen",
  "verwaltung.stammdaten.ferien_auto": "Ferienabruf umgestellt",
  "verwaltung.room.create": "Raum angelegt",
  "verwaltung.room.update": "Raum geändert",
  "verwaltung.room.delete": "Raum gelöscht",
  "verwaltung.room.activate": "Raum wieder in Betrieb genommen",
  "verwaltung.room.deactivate": "Raum außer Betrieb genommen",
  "monitor.create": "Monitor angelegt",
  "monitor.update": "Monitor geändert",
  "monitor.renew": "Monitor-Adresse erneuert",
  "monitor.revoke": "Monitor gesperrt",
  "monitor.delete": "Monitor gelöscht",
  "stundenplan.lesson.create": "Stunde angelegt",
  "stundenplan.lesson.update": "Stunde geändert",
  "stundenplan.lesson.delete": "Stunde gelöscht",
  "stundenplan.assignment.csv_import": "Unterrichtsverteilung aus CSV importiert",
  "stundenplan.band.create": "Band angelegt",
  "stundenplan.band.update": "Band geändert",
  "stundenplan.band.delete": "Band gelöscht",
  "stundenplan.band.member": "Lehrauftrag ins Band aufgenommen/herausgenommen",
  "stundenplan.substitution.save": "Vertretung eingetragen",
  "stundenplan.substitution.delete": "Vertretung aufgehoben",
  "stundenplan.substitution.publish": "Vertretungsplan veröffentlicht",
  "stundenplan.timepref.window": "Eingabefenster Zeitwünsche geändert",
  // Review R3 N6: Aktionen aus Stundenplan-Umbau und SP2
  "stundenplan.lesson.swap": "Stunden getauscht",
  "stundenplan.lesson.off_subject": "Stunde fachfremd vergeben",
  "stundenplan.lesson.fix": "Stunde für den Solver fixiert",
  "stundenplan.lesson.unfix": "Fixierung einer Stunde aufgehoben",
  "stundenplan.coupling.create": "Kopplung angelegt",
  "stundenplan.coupling.update": "Kopplung geändert",
  "stundenplan.coupling.delete": "Kopplung gelöscht",
  "stundenplan.period.copy": "Stundenplan ab Stichtag als neue Periode angelegt",
  "stundenplan.assignment.create": "Lehrauftrag angelegt",
  "stundenplan.assignment.update": "Lehrauftrag geändert",
  "stundenplan.assignment.delete": "Lehrauftrag gelöscht",
  "stundenplan.assignment.import": "Lehraufträge aus dem Stundenplan übernommen",
  "stundenplan.assignment.matrix": "Lehraufträge in der Matrix gespeichert",
  "stundenplan.assignment.off_subject": "Lehrauftrag fachfremd vergeben",
  "stundenplan.teacher_subjects": "Lehrfächer einer Lehrkraft geändert",
  "stundenplan.teacher_subjects.csv_import": "Lehrfächer aus CSV importiert",
  "stundenplan.deputy.obligation": "Pflichtstunden geändert",
  "stundenplan.deputy.reduction_add": "Ermäßigung eingetragen",
  "stundenplan.deputy.reduction_delete": "Ermäßigung gelöscht",
  "stundenplan.deputy.day_rule": "Tagesregel einer Lehrkraft geändert",
  "stundenplan.tagesgrenzen.save": "Tagesgrenzen je Jahrgang gespeichert",
  "stundenplan.timepref.save": "Zeitwünsche gespeichert",
  "stundenplan.forecast.grades": "Schülerzahl-Prognose geändert",
  "stundenplan.staff_change.add": "Personalveränderung eingetragen",
  "stundenplan.staff_change.delete": "Personalveränderung gelöscht",
  "stundenplan.solver.start": "Solver-Lauf gestartet",
  "stundenplan.solver.cancel": "Solver-Lauf abgebrochen",
  "stundenplan.solver.apply": "Solver-Lauf übernommen",
  "stundenplan.solver.undo": "Übernahme eines Solver-Laufs zurückgenommen",
  "stundenplan.solver.delete": "Solver-Lauf gelöscht",
  "stundenplan.absence.create": "Abwesenheit einer Lehrkraft eingetragen",
  "stundenplan.absence.delete": "Abwesenheit einer Lehrkraft gelöscht",
  "stundenplan.absence.shorten": "Abwesenheit einer Lehrkraft verkürzt",
  "stundenplan.absence.self": "Abwesenheit selbst gemeldet",
  "stundenplan.absence.withdraw": "Selbstmeldung zurückgezogen",
  "stundenplan.absence.approve": "Selbstmeldung genehmigt",
  "stundenplan.absence.reject": "Selbstmeldung abgelehnt",
  "stundenplan.material.save": "Vertretungsmaterial hinterlegt",
  "stundenplan.material.delete": "Vertretungsmaterial gelöscht",
  "stundenplan.standby.add": "Bereitschaft eingetragen",
  "stundenplan.standby.remove": "Bereitschaft entfernt",
  "stundenplan.duty.area_create": "Aufsichtsbereich angelegt",
  "stundenplan.duty.area_delete": "Aufsichtsbereich gelöscht",
  "stundenplan.duty.add": "Aufsicht eingetragen",
  "stundenplan.duty.remove": "Aufsicht entfernt",
  "stundenplan.duty.change": "Aufsicht vertreten",
  "stundenplan.duty.change_clear": "Aufsichtsvertretung aufgehoben",
  "stundenplan.roomblock.create": "Raumsperre angelegt",
  "stundenplan.roomblock.end": "Raumsperre vorzeitig beendet",
  "stundenplan.roomblock.delete": "Raumsperre gelöscht",
  "klassenbuch.entry.save": "Klassenbuch-Eintrag gespeichert",
  "abwesenheiten.report": "Abwesenheit gemeldet",
  "abwesenheiten.decide": "Abwesenheit entschieden",
  "elternbriefe.send": "Elternbrief verschickt",
  "elternbriefe.remind": "An Elternbrief erinnert",
  "buchungen.book": "Gebucht",
  "buchungen.cancel": "Buchung storniert",
  "klausurplan.create": "Arbeit eingetragen",
  "klausurplan.delete": "Arbeit gelöscht",
  "datenschutz.auskunft": "Auskunft erstellt",
  "datenschutz.eigenexport": "Eigene Daten heruntergeladen",
  "datenschutz.hinweise": "Datenschutzangaben geändert",
  "datenschutz.loeschantrag": "Löschung auf Antrag",
  "datenschutz.loeschlauf": "Löschlauf ausgeführt",
  "datenschutz.sperre.anlegen": "Löschsperre angelegt",
  "datenschutz.sperre.aufheben": "Löschsperre aufgehoben",
  "verwaltung.schuljahreswechsel.start": "Schuljahreswechsel gestartet",
  "verwaltung.schuljahreswechsel.versetzung": "Versetzung durchgeführt",
  "verwaltung.schuljahreswechsel.archiv": "Gruppen archiviert",
  "verwaltung.schuljahreswechsel.pruefung": "Löschprotokoll und Sperren geprüft",
  "verwaltung.schuljahreswechsel.neuaufnahmen": "Schuljahreswechsel: Neuaufnahmen übernommen",
  "verwaltung.schuljahreswechsel.abschluss": "Schuljahreswechsel abgeschlossen",
  "klassenbuch.archiv.export": "Klassenbuch-Archivexport erstellt",
  "klassenbuch.archiv.uebergabe": "Übergabe des Archivexports bestätigt",
  "konto.passwort.geaendert": "Eigenes Passwort geändert",
  "konto.sitzung.beendet": "Ein anderes Gerät abgemeldet",
  "konto.sitzung.ueberall_abgemeldet": "Überall abgemeldet",
  "konto.passwort.reset_angefordert": "Link „Passwort vergessen“ angefordert",
  "konto.passwort.reset_mail": "Passwort über den Link „Passwort vergessen“ geändert",
  "konto.anmeldung.gesperrt": "Anmeldung nach Fehlversuchen vorübergehend gesperrt",
  "verwaltung.user.anmeldesperre_aufgehoben": "Anmeldesperre aufgehoben",
  "konto.2fa.eingerichtet": "Zwei-Faktor-Anmeldung eingerichtet",
  "konto.2fa.codes": "Neue Wiederherstellungscodes erzeugt",
  "konto.2fa.deaktiviert": "Zwei-Faktor-Anmeldung ausgeschaltet",
  "verwaltung.user.2fa_reset": "Zwei-Faktor-Anmeldung zurückgesetzt",
  "verwaltung.user.2fa_codeliste": "Code-Liste für die Zwei-Faktor-Anmeldung erzeugt",
  "konto.2fa.codeliste_benutzt": "Mit Code von der Code-Liste angemeldet",
  "konto.2fa.codeliste_falsch": "Falscher Code von der Code-Liste",
  "verwaltung.user.2fa_freigabe":"Einrichtung der Zwei-Faktor-Anmeldung von außen freigegeben",
  "verwaltung.anmeldung.einstellungen": "Anmelde-Einstellungen geändert (Schulnetz, Zwei-Faktor-Pflicht, Inaktivität)",
  "verwaltung.anmeldung.schulnetz_zurueckgesetzt": "Schulnetz-Bereiche per Kommandozeile auf die Vorgabe zurückgesetzt",
  "profilbild.einwilligung": "Profilbild mit Einwilligung hinterlegt",
  "profilbild.widerruf": "Profilbild-Einwilligung widerrufen",
  "lesen.klassenbuch": "Klassenbuch eingesehen",
  "lesen.abwesenheiten": "Abwesenheiten eingesehen",
  "anmeldung.eingegangen": "Schulanmeldung online eingegangen (unbestätigt)",
  "anmeldung.bestaetigt": "Schulanmeldung per E-Mail bestätigt",
  "anmeldung.termin.eltern": "Schulanmeldung: Termin durch die Eltern geändert",
  "anmeldung.zurueckgezogen": "Schulanmeldung durch die Eltern zurückgezogen",
  "anmeldung.antrag.termin": "Schulanmeldung: Termin gesetzt",
  "anmeldung.antrag.unterlagen": "Schulanmeldung: Unterlagen abgehakt",
  "anmeldung.antrag.notiz": "Schulanmeldung: Notiz",
  "anmeldung.antrag.status": "Schulanmeldung: Stand geändert",
  "anmeldung.entscheidung.liste": "Schulanmeldung: Entscheidung für eine Auswahl",
  "anmeldung.spam": "Schulanmeldung: Auswahl als Spam abgelehnt (ohne Mail)",
  "anmeldung.spam.verdacht": "Schulanmeldung: Auswahl als Spam-Verdacht markiert",
  "anmeldung.spam.verdacht.zurueck": "Schulanmeldung: Spam-Verdacht zurückgenommen",
  "sitzplan.anlegen": "Sitzplan angelegt",
  "sitzplan.kopieren": "Sitzplan kopiert",
  "sitzplan.loeschen": "Sitzplan gelöscht",
  "buecherei.title.create": "Bücherei: Titel angelegt",
  "buecherei.title.update": "Bücherei: Titel geändert",
  "buecherei.title.delete": "Bücherei: Titel gelöscht",
  "buecherei.copy.create": "Bücherei: Exemplare angelegt",
  "buecherei.copy.update": "Bücherei: Exemplar geändert",
  "buecherei.copy.withdraw": "Bücherei: Exemplar ausgesondert",
  "buecherei.copy.restore": "Bücherei: Aussonderung zurückgenommen",
  "buecherei.import": "Bücherei: Bestand importiert",
  "buecherei.loan.finding": "Bücherei: Rückgabe mit Befund",
  "buecherei.loan.resolve": "Bücherei: Befund erledigt",
  "buecherei.card.create": "Bücherei: Ausweise angelegt",
  "buecherei.card.replace": "Bücherei: Ausweis ersetzt",
  "buecherei.material.return_day": "Bücherei: Rückgabetag der Schulbücher festgelegt",
  "buecherei.compensation.create": "Bücherei: Ersatzforderung angelegt",
  "buecherei.compensation.update": "Bücherei: Ersatzforderung geändert",
  "buecherei.compensation.status": "Bücherei: Stand einer Ersatzforderung geändert",
  "buecherei.compensation.letter": "Bücherei: Ersatzbrief erstellt",
  "buecherei.compensation.note": "Bücherei: Hinweis im Ersatzbrief geändert",
  "kurse.konferenz.setzen": "Kursraum: Konferenzlink gesetzt",
  "kurse.konferenz.entfernen": "Kursraum: Konferenzlink entfernt",
  "notenbuch.anlegen": "Notenbuch angelegt",
  "notenbuch.spalte": "Notenbuch: Spalte angelegt",
  "notenbuch.spalte.aendern": "Notenbuch: Spalte geändert",
  "notenbuch.spalte.loeschen": "Notenbuch: Spalte gelöscht",
  "notenbuch.gewichte": "Notenbuch: Gewichtung geändert",
  "notenbuch.uebertragen": "Notenbuch übertragen",
  "notenbuch.festlegen": "Notenbuch: Vorschläge als Halbjahresnoten übernommen",
  "notenbuch.abschliessen": "Notenbuch abgeschlossen und gesperrt",
  "notenbuch.entsperren": "Notenbuch entsperrt",
  "notenbuch.export": "Halbjahreswerte exportiert (CSV)",
  "notenbuch.offline.ein": "Notenbuch: Offline-Eingabe auf einem Gerät eingeschaltet",
  "notenbuch.offline.aus": "Notenbuch: Offline-Eingabe auf einem Gerät beendet",
  "notenbuch.offline.abgleich": "Notenbuch: Offline-Änderungen abgeglichen",
  "lesen.notenbuch": "Halbjahreswerte (Notenbuch) eingesehen",
  "lesen.notenbuch.auskunft": "Notenbuch-Teil einer Auskunft (Art. 15) erteilt",
  "anmeldung.verfahren.abschliessen": "Anmeldeverfahren abgeschlossen",
  "anmeldung.export.svs": "Schulanmeldung: Export für die Schulverwaltungssoftware",
  "anmeldung.export.serienbrief": "Schulanmeldung: Serienbrief-Export",
  "lesen.anmeldung": "Schulanmeldung eingesehen",
  "kurswahl.verfahren.create": "Kurswahl: Verfahren angelegt",
  "kurswahl.verfahren.update": "Kurswahl: Verfahren geändert",
  "kurswahl.verfahren.delete": "Kurswahl: Verfahren gelöscht (Wahlen entfallen)",
  "kurswahl.angebot.create": "Kurswahl: Angebot angelegt",
  "kurswahl.angebot.update": "Kurswahl: Angebot geändert",
  "kurswahl.angebot.delete": "Kurswahl: Angebot gelöscht",
  "kurswahl.choose": "Kurswahl: Wahl abgegeben",
  "kurswahl.confirm": "Kurswahl: Wahl von den Eltern bestätigt",
  "kurswahl.remind": "Kurswahl: Erinnerung an Nichtwähler",
  "kurswahl.remind.auto": "Kurswahl: automatische Erinnerung an Nichtwähler",
  "kurswahl.angebot.off_subject": "Kurswahl: Angebot mit fachfremder Lehrkraft",
  "kurswahl.allocate": "Kurswahl: Zuteilung berechnet",
  "kurswahl.assign": "Kurswahl: Zuteilung von Hand korrigiert",
  "kurswahl.transfer": "Kurswahl: in Gruppen übernommen",
  "kurswahl.assignments": "Kurswahl: Lehraufträge aus dem Vorschlag angelegt",
  "sprechtag.event.create": "Elternsprechtag angelegt",
  "sprechtag.event.update": "Elternsprechtag geändert",
  "sprechtag.event.delete": "Elternsprechtag gelöscht (Termine entfallen)",
  "sprechtag.book": "Sprechtag: Termin(e) gebucht",
  "sprechtag.cancel": "Sprechtag: Termin abgesagt",
  "sprechtag.invite": "Sprechtag: Gesprächswunsch an Eltern geschickt",
  "verwaltung.backup.gekoppelt": "Backupserver gekoppelt",
  "verwaltung.backup.kopplung_fehlgeschlagen": "Kopplung mit dem Backupserver fehlgeschlagen",
  "verwaltung.backup.wiederherstellungsschluessel": "Wiederherstellungsschlüssel als verwahrt bestätigt",
  "verwaltung.backup.entkoppelt": "Backupserver entkoppelt",
  "verwaltung.backup.angefordert": "Sicherung angefordert (Jetzt sichern)",
  "verwaltung.backup.wiederherstellung_bestaetigt": "Wiederherstellung bestätigt",
  "verwaltung.backup.wiederherstellung_code_falsch": "Wiederherstellung: falscher Bestätigungscode",
  "verwaltung.backup.wiederherstellung_abgelehnt": "Wiederherstellung abgelehnt",
  "verwaltung.system.update_freigegeben": "SchulOS-Update freigegeben",
  "verwaltung.system.kanal": "Update-Kanal geändert",
  "verwaltung.system.testmail": "Testmail gesendet",
  "verwaltung.system.neustart": "Neustart des Servers ausgelöst",
  "system.admin_zurueckgesetzt": "Admin-Zugang auf dem Server zurückgesetzt (schulosctl)",
};

export const ACTION_FILTERS = [
  { value: "verwaltung.user.", label: "Benutzer" },
  { value: "verwaltung.group.", label: "Gruppen" },
  { value: "verwaltung.rights.", label: "Rechte" },
  { value: "verwaltung.module.", label: "Module" },
  { value: "verwaltung.import.", label: "Import" },
  { value: "verwaltung.stammdaten.", label: "Stammdaten" },
  { value: "verwaltung.room.", label: "Räume" },
  { value: "verwaltung.schuljahreswechsel.", label: "Schuljahreswechsel" },
  { value: "verwaltung.backup.", label: "Backup" },
  { value: "verwaltung.system.", label: "System" },
  { value: "stundenplan.", label: "Stundenplan" },
  { value: "klassenbuch.", label: "Klassenbuch" },
  { value: "abwesenheiten.", label: "Abwesenheiten" },
  { value: "elternbriefe.", label: "Elternbriefe" },
  { value: "buchungen.", label: "Buchungen" },
  { value: "klausurplan.", label: "Klausurplan" },
  { value: "notenbuch.", label: "Notenbuch" },
  { value: "monitor.", label: "Monitore" },
  { value: "datenschutz.", label: "Datenschutz" },
  { value: "konto.", label: "Anmeldung und Zwei-Faktor" },
  { value: "profilbild.", label: "Profilbilder" },
  { value: "lesen.", label: "Lesezugriffe" },
];

export interface AuditEntry {
  id: number;
  at: Date;
  actor: string;
  action: string;
  label: string;
  target: string;
  detail?: string;
  pseudonymized: boolean;
}

export async function listAudit(db: Db, f: { prefix?: string; page?: number } = {}): Promise<{ rows: AuditEntry[]; total: number }> {
  const where: SQL[] = [];
  if (f.prefix) where.push(like(auditLog.action, `${f.prefix.replace(/[%_\\]/g, "")}%`));
  const cond = where.length ? and(...where) : undefined;
  const page = Math.max(1, f.page ?? 1);
  const actor = alias(users, "actor");

  const [raw, [totalRow]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        at: auditLog.createdAt,
        action: auditLog.action,
        target: auditLog.target,
        meta: auditLog.meta,
        actorName: actor.name,
        actorPseudonym: auditLog.actorPseudonym,
      })
      .from(auditLog)
      .leftJoin(actor, eq(actor.id, auditLog.actorId))
      .where(cond)
      .orderBy(desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ n: count() }).from(auditLog).where(cond),
  ]);

  // Ziele (Benutzer/Gruppen) in einem Rutsch auflösen
  const rawTargets = raw.map((r) => r.target ?? "");
  const userIds = rawTargets.filter((t) => t.startsWith("u-"));
  const groupIds = [
    ...rawTargets.filter((t) => t.startsWith("g-") || /^[0-9a-f-]{36}$/.test(t)),
    ...rawTargets.filter((t) => t.startsWith("group:")).map((t) => t.slice(6)),
  ];
  const [userNames, groupNames] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : [],
  ]);
  const names = new Map<string, string>([...userNames, ...groupNames].map((x) => [x.id, x.name]));

  const describe = (target: string | null, meta: unknown): string => {
    const m = (meta ?? {}) as Record<string, unknown>;
    if (!target) return "";
    if (target.startsWith("role:")) return `Rolle ${ROLE_LABELS[target.slice(5) as Role] ?? target.slice(5)}`;
    if (target.startsWith("group:")) return names.get(target.slice(6)) ?? "(gelöschte Gruppe)";
    if (isPseudonym(target)) return `Pseudonym ${target}`;
    return names.get(target) ?? (typeof m.name === "string" ? m.name : target);
  };

  return {
    rows: raw.map((r) => {
      const m = (r.meta ?? {}) as Record<string, unknown>;
      const detail =
        typeof m.permission === "string"
          ? m.permission
          : typeof m.count === "number"
            ? `${m.count} Konten`
            : Array.isArray(m.userIds)
              ? `${m.userIds.length} Personen`
              : typeof m.feature === "string"
                ? `${m.feature}: ${m.enabled ? "an" : "aus"}`
                : r.action === "lesen.klassenbuch"
                  ? typeof m.date === "string"
                    ? `Stunde am ${m.date}`
                    : "Woche und Fehlzeiten"
                  : undefined;
      return {
        id: r.id,
        at: r.at,
        actor: r.actorName ?? (r.actorPseudonym ? `Pseudonym ${r.actorPseudonym}` : "System"),
        pseudonymized: Boolean(r.actorPseudonym) || isPseudonym(r.target),
        action: r.action,
        label: ACTION_LABELS[r.action] ?? r.action,
        target: describe(r.target, r.meta),
        detail,
      };
    }),
    total: totalRow?.n ?? 0,
  };
}
