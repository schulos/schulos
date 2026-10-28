import { defineModule } from "@/core/modules/types";
import { HILFE_SETTINGS } from "./settings";

// Handbuch (Block HB, docs/HANDBUCH.md): schulinternes Nachschlagewerk „So läuft es bei uns“. Lesen darf jede angemeldete
// Person – sichtbar ist eine Seite nur für ihre Zielgruppen (der Service filtert selbst), Entwürfe nur für Pflegende und die
// Ansprechperson. Später: Anhänge (HB-05), Verlauf (HB-06), Starter-Seiten und Kontexthilfe (HB-07).
export default defineModule({
  id: "hilfe",
  name: "Handbuch",
  description: "Abläufe und Anleitungen der Schule für Personal, Schüler:innen und Eltern – gegliedert, durchsuchbar, mit Ansprechperson",
  icon: "LifeBuoy",
  section: "organisation",
  order: 90,
  permissions: {
    "hilfe.edit": "Handbuch bearbeiten: Bereiche und Seiten anlegen, ändern und veröffentlichen",
    "hilfe.manage": "Handbuch verwalten: zusätzlich Seiten und Bereiche löschen",
  },
  // Funktionsgruppen (IT, Hausmeisterei, Fachschaften) bekommen „Handbuch bearbeiten“ über Gruppenrechte
  defaultGrants: { verwaltung: ["hilfe.edit", "hilfe.manage"] },
  settings: HILFE_SETTINGS,
  nav: [{ href: "/hilfe", label: "Handbuch" }],
  retention: [
    {
      table: "hilfe_pages",
      purpose: "Interne Hilfe und Anleitungen der Schule (Ansprechperson und Bearbeiter:in je Seite)",
      categories: ["Ansprechperson", "angelegt/zuletzt geändert von", "Zeitpunkte", "Seiteninhalt (organisatorisch, ohne Schülerdaten)"],
      class: "LK-KONTO",
      start: "contact_id",
      note: "Seiten werden nie automatisch gelöscht; nur die Verweise auf Personen (Ansprechperson, angelegt/geändert von) folgen dem Konto und werden bei der Kontolöschung geleert",
    },
    { table: "hilfe_targets", purpose: "Zielgruppen einer Handbuchseite", categories: ["Rolle oder Gruppe"], follows: "hilfe_pages" },
  ],
  processing: {
    title: "Handbuch (interne Hilfe und Anleitungen)",
    purpose: "Abläufe und Anleitungen der Schule an einer Stelle nachlesen; Pflege durch benannte Ansprechpersonen",
    subjects: ["Lehrkräfte", "Verwaltungspersonal", "weiteres Personal (als Ansprechperson oder Bearbeiter:in)"],
    recipients: ["Zielgruppen der Seite (Rollen oder Gruppen; Eltern über die Gruppen ihrer Kinder)", "Pflegende mit „Handbuch bearbeiten“"],
    note: "Inhalt ist organisatorisch; der Editor weist darauf hin, keine Schülerdaten sowie keine Gesundheits- oder Notendaten einzutragen. Kein Zugriff ohne Anmeldung. Die Erinnerung „Überprüfung fällig“ geht nur an die Ansprechperson.",
  },
});
