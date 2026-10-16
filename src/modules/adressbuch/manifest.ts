import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "adressbuch",
  name: "Adressbuch",
  description: "Lehrkräfte, Mitschüler:innen und Gruppen finden",
  icon: "Users",
  section: "kommunikation",
  order: 90,
  nav: [{ href: "/adressbuch", label: "Adressbuch" }],
  processing: {
    title: "Adressbuch",
    purpose: "Ansprechpersonen und Gruppen innerhalb der Schule finden",
    subjects: ["Schüler:innen", "Eltern", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["angemeldete Nutzer:innen nach Sichtbarkeitsregeln (Schüler:innen sehen nur ihre Gruppen und das Kollegium)"],
    note: "Speichert nichts Eigenes, zeigt Name, Rolle, Kürzel und Gruppen aus den Benutzerkonten.",
  },
});
