import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "monitor",
  name: "Statusmonitor",
  description: "Vertretungsplan auf Bildschirmen im Foyer und Lehrerzimmer",
  icon: "MonitorPlay",
  section: "verwaltung",
  order: 90,
  permissions: {
    "monitor.manage": "Monitore anlegen, Adressen erneuern und widerrufen",
  },
  defaultGrants: { verwaltung: ["monitor.manage"] },
  processing: {
    title: "Statusmonitore",
    purpose: "Vertretungsplan, Termine und Hinweise auf Bildschirmen im Schulgebäude anzeigen",
    subjects: ["Lehrkräfte"],
    recipients: ["Personen im Gebäude (Foyer bzw. Lehrerzimmer)"],
    note: "Lehrkräfte erscheinen nur mit Kürzel; Schüler:innen werden nicht namentlich angezeigt.",
  },
});
