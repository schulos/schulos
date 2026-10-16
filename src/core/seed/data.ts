// Stammdaten der Demo-Schule „Gesamtschule am Lindenhof" (NRW, Sek I + Oberstufe).
import type { RoomEquipment, RoomKind } from "@/core/db/schema";

export const SCHOOL_NAME = "Gesamtschule am Lindenhof";
export const SCHOOL_COLOR = "#0E7C66";
export const DEMO_PASSWORD = "schulos";

/** Impressum der Demo-Schule (Q5-22) – fiktiv, alle Pflichtfelder gefüllt (sonst ließe sich keine Schulanmeldung veröffentlichen). */
export const DEMO_IMPRESSUM = {
  name: SCHOOL_NAME,
  legalForm: "Öffentliche Schule in Trägerschaft der Stadt Musterstadt (fiktive Demo-Schule)",
  street: "Lindenweg 1",
  postalCode: "12345",
  city: "Musterstadt",
  representedBy: "Petra Lindner, Schulleiterin",
  email: "sekretariat@lindenhof.example.org",
  phone: "0123 456789-0",
  schoolAuthority: "Stadt Musterstadt, Der Bürgermeister, Rathausplatz 1, 12345 Musterstadt",
  supervisoryAuthority: "Bezirksregierung Musterstadt",
  register: "",
  vatId: "",
  additional: "Demo-Instanz von SchulOS mit erfundenen Daten.",
};

/**
 * Ferien der Demo-Schule (NRW 2026/27). Demo-Daten nach bestem Wissen, nicht amtlich geprüft –
 * eine echte Schule gleicht sie mit dem Ferienkalender des Landes ab.
 */
export const DEMO_CLOSURES: { kind: "ferien" | "frei"; name: string; startsOn: string; endsOn: string }[] = [
  { kind: "ferien", name: "Sommerferien 2026", startsOn: "2026-07-20", endsOn: "2026-09-01" },
  { kind: "ferien", name: "Herbstferien", startsOn: "2026-10-17", endsOn: "2026-10-31" },
  { kind: "ferien", name: "Weihnachtsferien", startsOn: "2026-12-23", endsOn: "2027-01-06" },
  { kind: "frei", name: "Pädagogischer Tag", startsOn: "2027-02-08", endsOn: "2027-02-08" },
  { kind: "ferien", name: "Osterferien", startsOn: "2027-03-22", endsOn: "2027-04-03" },
  { kind: "frei", name: "Beweglicher Ferientag", startsOn: "2027-05-07", endsOn: "2027-05-07" },
  { kind: "ferien", name: "Pfingstferien", startsOn: "2027-05-18", endsOn: "2027-05-18" },
  { kind: "ferien", name: "Sommerferien 2027", startsOn: "2027-07-19", endsOn: "2027-08-31" },
];

const FLOORS = ["EG", "1. OG", "2. OG"];

export const ROOMS: {
  id: string;
  name: string;
  kind: RoomKind;
  building: string;
  floor: string;
  capacity: number;
  equipment: RoomEquipment[];
  accessible: boolean;
}[] = [
  ...[1, 2, 3].flatMap((floor) =>
    Array.from({ length: floor === 3 ? 6 : 12 }, (_, i) => {
      const id = `${floor}${String(i + 1).padStart(2, "0")}`;
      // Hauptgebäude: EG barrierefrei, im EG schon digitale Tafeln, sonst Beamer
      const equipment: RoomEquipment[] = floor === 1 ? ["tafel_digital", "lehrer_pc"] : ["beamer", "dokukamera"];
      return { id, name: `Raum ${id}`, kind: "klassenraum" as const, building: "Hauptgebäude", floor: FLOORS[floor - 1]!, capacity: floor === 3 ? 24 : 30, equipment, accessible: floor === 1 };
    }),
  ),
  { id: "NW1", name: "Biologie-Raum", kind: "nw", building: "Naturwissenschaften", floor: "EG", capacity: 28, equipment: ["beamer", "waschbecken"], accessible: true },
  { id: "NW2", name: "Chemie-Raum", kind: "nw", building: "Naturwissenschaften", floor: "EG", capacity: 28, equipment: ["beamer", "waschbecken", "abzug"], accessible: true },
  { id: "NW3", name: "Physik-Raum", kind: "nw", building: "Naturwissenschaften", floor: "1. OG", capacity: 28, equipment: ["beamer", "dokukamera"], accessible: false },
  { id: "IF1", name: "Informatik-Raum", kind: "informatik", building: "Hauptgebäude", floor: "1. OG", capacity: 26, equipment: ["beamer", "lehrer_pc", "schueler_pcs"], accessible: false },
  { id: "KU1", name: "Kunstraum", kind: "kunst", building: "Pavillon", floor: "EG", capacity: 26, equipment: ["waschbecken", "beamer"], accessible: true },
  { id: "MU1", name: "Musikraum", kind: "musik", building: "Pavillon", floor: "EG", capacity: 30, equipment: ["audio", "beamer"], accessible: true },
  { id: "TH1", name: "Sporthalle 1", kind: "sport", building: "Sporthalle", floor: "EG", capacity: 60, equipment: ["audio"], accessible: true },
  { id: "TH2", name: "Sporthalle 2", kind: "sport", building: "Sporthalle", floor: "EG", capacity: 60, equipment: ["audio"], accessible: true },
  { id: "BIB", name: "Bibliothek", kind: "sonstiges", building: "Hauptgebäude", floor: "EG", capacity: 40, equipment: ["schueler_pcs"], accessible: true },
  { id: "015", name: "Raum 015", kind: "klassenraum", building: "Hauptgebäude", floor: "EG", capacity: 30, equipment: ["beamer"], accessible: true },
];

/** Lehrkräfte: [Vorname, Nachname, Kürzel, Fächer]. Die ersten Einträge tauchen im UI-Konzept auf. */
export const TEACHERS: [string, string, string, string[]][] = [
  ["Jana", "Brandt", "BRA", ["D", "E"]],
  ["Tobias", "Kleine", "KLE", ["M", "PH"]],
  ["Daniel", "Okafor", "OKA", ["BI", "SP"]],
  ["Petra", "Lindner", "LIN", ["GE", "D"]],
  ["Murat", "Yilmaz", "YIL", ["M", "IF"]],
  ["Sophie", "Wagner", "WAG", ["E", "F"]],
  ["Henrik", "Albers", "ALB", ["CH", "BI"]],
  ["Aylin", "Demir", "DEM", ["PK", "EK"]],
  ["Markus", "Hoffmann", "HOF", ["SP", "EK"]],
  ["Claudia", "Becker", "BEC", ["KU", "D"]],
  ["Jonas", "Richter", "RIC", ["MU", "REL"]],
  ["Elena", "Popescu", "POP", ["M", "CH"]],
  ["Frank", "Schulte", "SLT", ["PH", "IF"]],
  ["Miriam", "Weber", "WEB", ["D", "PK"]],
  ["Stefan", "Krause", "KRA", ["GE", "EK"]],
  ["Nadine", "Vogel", "VOG", ["E", "SP"]],
  ["Ali", "Hassan", "HAS", ["M", "PH"]],
  ["Katrin", "Schmitz", "SCZ", ["BI", "CH"]],
  ["Ralf", "Neumann", "NEU", ["REL", "GE"]],
  ["Julia", "Fischer", "FIS", ["D", "MU"]],
  ["Thomas", "Bauer", "BAU", ["SP", "BI"]],
  ["Leonie", "Kaiser", "KAI", ["F", "D"]],
  ["Benedikt", "Lange", "LAN", ["IF", "M"]],
  ["Svenja", "Peters", "PET", ["KU", "E"]],
  ["Oliver", "Graf", "GRA", ["PK", "GE"]],
  ["Hannah", "Roth", "ROT", ["E", "EK"]],
  ["Christian", "Lorenz", "LOR", ["CH", "PH"]],
  ["Yasemin", "Aksoy", "AKS", ["M", "SP"]],
];

export const FIRST_NAMES = [
  "Lea", "Mia", "Emma", "Hannah", "Sophia", "Lina", "Emilia", "Marie", "Ella", "Clara", "Lena", "Amelie",
  "Ida", "Frieda", "Mila", "Nele", "Leni", "Zoe", "Elif", "Aylin", "Defne", "Amira", "Sara", "Yara",
  "Noah", "Ben", "Paul", "Leon", "Finn", "Elias", "Felix", "Henry", "Luca", "Emil", "Jonas", "Theo",
  "Mats", "Anton", "Moritz", "Jakob", "Mo", "Yusuf", "Emir", "Can", "Malik", "Milan", "Luis", "Ole",
];

export const LAST_NAMES = [
  "Schäfer", "Müller", "Schmidt", "Schneider", "Fischer", "Meyer", "Weber", "Wagner", "Becker", "Schulz",
  "Hoffmann", "Koch", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun",
  "Krüger", "Hofmann", "Hartmann", "Lange", "Schmitt", "Werner", "Krause", "Meier", "Lehmann", "Köhler",
  "Nowak", "Kowalski", "Yildiz", "Öztürk", "Kaya", "Arslan", "Rossi", "Popović", "Nguyen", "Haddad",
  "Jansen", "de Vries", "Brinkmann", "Kemper", "Terhorst", "Lindemann", "Vogt", "Busch",
];

export const PARENT_FIRST_NAMES = [
  "Markus", "Sandra", "Stefan", "Nicole", "Andreas", "Katja", "Michael", "Melanie", "Thorsten", "Anja",
  "Sebastian", "Christina", "Emre", "Fatma", "Piotr", "Agnieszka", "Daniela", "Jörg", "Ayşe", "Mehmet",
];

/** Sek-I-Klassen 5a … 10b */
export const CLASSES = [5, 6, 7, 8, 9, 10].flatMap((grade) => ["a", "b"].map((letter) => ({ grade, letter })));

/** Oberstufen-Jahrgänge */
export const UPPER_GRADES = [
  { slug: "ef", name: "Jahrgang EF", grade: 11 },
  { slug: "q1", name: "Jahrgang Q1", grade: 12 },
  { slug: "q2", name: "Jahrgang Q2", grade: 13 },
];

export const AGS = [
  { slug: "ag-schuelerzeitung", name: "AG Schülerzeitung", leader: "BRA" },
  { slug: "ag-robotik", name: "AG Robotik", leader: "LAN" },
  { slug: "ag-schulchor", name: "AG Schulchor", leader: "RIC" },
  { slug: "ag-fussball", name: "AG Fußball", leader: "HOF" },
];
