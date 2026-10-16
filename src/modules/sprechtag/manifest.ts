import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "sprechtag",
  name: "Elternsprechtag",
  description: "Sprechtage mit Terminbuchung: Lehrkräfte geben Zeiten frei, Eltern buchen je Kind – auch hintereinander",
  icon: "CalendarClock",
  section: "organisation",
  order: 28,
  permissions: {
    "sprechtag.manage": "Sprechtage anlegen und ändern, alle Pläne sehen und drucken, Termine absagen",
    "sprechtag.offer": "An Sprechtagen Gesprächszeiten anbieten und Gesprächswünsche an Eltern schicken",
  },
  // Eltern buchen über die Eltern-Kind-Verknüpfung (nur für minderjährige Kinder), eigenständige Schüler:innen für sich
  defaultGrants: { lehrkraft: ["sprechtag.offer"], verwaltung: ["sprechtag.manage"] },
  nav: [
    { href: "/sprechtag", label: "Elternsprechtag", roles: ["lehrkraft", "verwaltung", "admin"] },
    { href: "/sprechtag/buchen", label: "Elternsprechtag", roles: ["eltern"] },
    // G4D-C09: eigenständige (volljährige) Schüler:innen buchen selbst
    { href: "/sprechtag/buchen", label: "Elternsprechtag", roles: ["schueler"], selfResponsible: true },
  ],
  retention: [
    {
      table: "sprechtag_events",
      purpose: "Sprechtage organisieren (Datum, Zeitraster, Buchungsfenster)",
      categories: ["Titel", "Datum und Zeitraster", "Buchungsfenster"],
      class: "LK-SJ",
      start: "date",
      note: "mit dem Sprechtag gehen Verfügbarkeiten, Termine und Gesprächswünsche",
    },
    {
      table: "sprechtag_availability",
      purpose: "Teilnahme der Lehrkräfte (Raum, angebotene Zeiten)",
      categories: ["Lehrkraft", "Raum", "nicht angebotene Zeiten"],
      follows: "sprechtag_events",
    },
    {
      table: "sprechtag_appointments",
      purpose: "Gesprächstermine zwischen Eltern bzw. eigenständigen Schüler:innen und Lehrkräften",
      categories: ["Lehrkraft", "Schüler:in", "buchende Person", "Uhrzeit"],
      class: "LK-SJ",
      start: "starts_at",
      note: "Absagen löschen den Termin sofort; keine Gesprächsinhalte",
    },
    {
      table: "sprechtag_invitations",
      purpose: "Gesprächswunsch einer Lehrkraft an die Eltern",
      categories: ["Lehrkraft", "Schüler:in", "Zeitpunkt"],
      follows: "sprechtag_events",
    },
  ],
  processing: {
    title: "Elternsprechtag",
    purpose: "Gesprächstermine zwischen Eltern (bzw. eigenständigen Schüler:innen) und Lehrkräften vergeben und organisieren",
    legalBasis: "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1 und § 44 Abs. 1 SchulG NRW (Information und Beratung der Eltern)",
    subjects: ["Eltern", "Schüler:innen", "Lehrkräfte"],
    recipients: [
      "die gebuchte Lehrkraft (Name der Schüler:in, Klasse, buchende Person, Uhrzeit)",
      "Eltern minderjähriger Kinder bzw. die eigenständige Schüler:in (eigene Termine; bei Lehrkräften nur „frei“/„belegt“)",
      "Personen mit dem Recht „Sprechtage anlegen“ (alle Pläne)",
      "Monitor „Sprechtag“ im Foyer: nur Lehrkräfte und Räume, keine Eltern- oder Schülernamen",
    ],
    note: "Keine Gesprächsinhalte und keine Notizen. Eltern sehen bei Lehrkräften nur freie und belegte Zeiten, nie andere Familien. Gebucht werden nur Lehrkräfte, die das Kind unterrichten oder seine Klasse leiten. Volljährige mit dem Kennzeichen „eigenständig“ buchen selbst.",
  },
});
