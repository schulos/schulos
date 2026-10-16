import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "kurswahl",
  name: "Kurswahlen",
  description: "Wahlpflicht-, Religions-, AG- und Fachwahlen mit Wünschen, nachvollziehbarer Zuteilung und Übernahme in Gruppen",
  icon: "ListOrdered",
  section: "unterricht",
  order: 40,
  permissions: {
    "kurswahl.manage": "Wahlverfahren anlegen, Wahlen einsehen, Kurse zuteilen und in Gruppen übernehmen",
  },
  // gewählt wird per Rolle: Eltern minderjähriger Kinder bzw. Schüler:innen (je Verfahren), Volljährige selbst
  defaultGrants: { verwaltung: ["kurswahl.manage"] },
  nav: [
    { href: "/kurswahl", label: "Kurswahl", roles: ["schueler", "eltern"] },
    { href: "/kurswahl", label: "Kurswahlen", requires: "kurswahl.manage", roles: ["lehrkraft", "verwaltung", "admin"] },
  ],
  retention: [
    {
      table: "kurswahl_verfahren",
      purpose: "Wahlverfahren organisieren (Zielgruppe, Zeitraum, Zuteilung)",
      categories: ["Titel", "Jahrgang/Klassen", "Zeitraum", "Seed des Loses"],
      class: "LK-ENDE-1J",
      start: "closes_on",
      note: "mit dem Verfahren gehen Angebote und Wahlen",
    },
    {
      table: "kurswahl_angebote",
      purpose: "Wählbare Kurse mit Kapazität und vorgesehener Lehrkraft",
      categories: ["Titel", "Fach", "Kapazität", "Lehrkraft"],
      follows: "kurswahl_verfahren",
    },
    {
      table: "kurswahl_wahlen",
      purpose: "Wünsche der Schüler:innen und das Ergebnis der Zuteilung",
      categories: ["Schüler:in", "Wünsche (Priorität)", "abgebende/bestätigende Person", "Zeitpunkt", "zugeteilter Kurs mit Begründung"],
      class: "LK-SJ-1J",
      start: "created_at",
      note: "Das Ergebnis lebt danach als Gruppenmitgliedschaft weiter",
    },
  ],
  processing: {
    title: "Kurswahlen",
    purpose: "Wünsche für Wahlpflicht-, Religions-, AG- und Fachwahlen erheben, Kurse zuteilen und Lerngruppen bilden",
    legalBasis: "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1 SchulG NRW, VO-DV I (Unterrichtsorganisation)",
    subjects: ["Schüler:innen", "Eltern", "Lehrkräfte"],
    recipients: [
      "die wählende Familie (nur die eigene Wahl und das eigene Ergebnis; Eltern minderjähriger Kinder bzw. die eigenständige Person)",
      "Personen mit dem Recht „Kurswahlen verwalten“ (alle Wahlen, Zuteilung)",
      "die Lehrkraft eines Kurses (Mitglieder der entstandenen Gruppe)",
    ],
    note: "Familien sehen weder Wahlen anderer noch die Nachfrage. Die Zuteilung ist deterministisch (Wünsche, Kapazitäten, Mindestgröße, protokolliertes Los) und je Person begründet. Volljährige mit dem Kennzeichen „eigenständig“ wählen selbst. Keine Prüfung der Belegungsvorschriften der Oberstufe.",
  },
});
