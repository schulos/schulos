import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "elternbriefe",
  name: "Elternbriefe",
  description: "Briefe an Eltern mit Lesebestätigung und Rückmeldung",
  icon: "Mail",
  section: "kommunikation",
  order: 30,
  permissions: {
    "elternbriefe.send": "Elternbriefe an eigene Klassen/Kurse schicken",
    "elternbriefe.send_all": "Elternbriefe an alle Klassen schicken",
  },
  defaultGrants: { lehrkraft: ["elternbriefe.send"], verwaltung: ["elternbriefe.send", "elternbriefe.send_all"] },
  nav: [
    { href: "/elternbriefe", label: "Elternbriefe", roles: ["eltern", "lehrkraft", "verwaltung", "admin"] },
    // G4D-C09: eigenständige (volljährige) Schüler:innen bekommen die Elternbriefe selbst (DS-19)
    { href: "/elternbriefe", label: "Elternbriefe", roles: ["schueler"], selfResponsible: true },
  ],
  retention: [
    {
      table: "parent_letters",
      purpose: "Eltern informieren und Rückmeldungen einholen",
      categories: ["Brieftext", "Anhang", "Verfasser:in", "Zeitpunkt"],
      class: "LK-SJ-1J",
      start: "created_at",
    },
    { table: "parent_letter_groups", purpose: "Empfängergruppen eines Briefs", categories: ["Gruppe"], follows: "parent_letters" },
    {
      table: "parent_letter_receipts",
      purpose: "Lesebestätigung und Rückmeldung",
      categories: ["Schüler:in", "gelesen", "bestätigt von", "Antwort"],
      follows: "parent_letters",
    },
  ],
  processing: {
    title: "Elternbriefe",
    purpose: "Eltern informieren, Kenntnisnahme und Rückmeldungen einholen",
    subjects: ["Eltern", "Schüler:innen", "Lehrkräfte"],
    recipients: ["Verfasser:in des Briefs", "Klassenleitung", "Schulleitung"],
  },
});
