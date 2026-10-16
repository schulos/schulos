// Demo (P4-41): offenes Verfahren „Klasse 5 – 2027/28“ mit Gesprächsterminen und 30 fiktiven Anträgen in allen Status, die
// vor einer Übernahme vorkommen (übernommen wird erst im Schuljahreswechsel in 2027/28 – das zeigt der Schritt „Neuaufnahmen“
// mit den aufgenommenen Anträgen). Alle Namen und Adressen sind erfunden, E-Mail-Adressen unter example.org.
// Zeiten relativ zu „jetzt“: zwei Gesprächstage liegen in der Vergangenheit (Unterlagen geprüft, entschieden), vier vor uns.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { parentChild, schoolYears, users } from "@/core/db/schema";
import { createRng } from "@/core/seed/rng";
import { addDays, toBerlinDate, weekdayMon0 } from "@/core/time";
import { CHECKLIST_KEYS } from "./katalog";
import { ANTRAG_STATUS_LABELS as L, type AntragStatus } from "./labels";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren } from "./schema";
import { generateSlots } from "./service";

export const DEMO_TARGET_YEAR_ID = "sj-2027-28";
export const DEMO_VERFAHREN_ID = "anm-klasse5-2027";
export const DEMO_VERFAHREN_NAME = "Klasse 5 – 2027/28";

/** Status-Verteilung der 30 Demo-Anträge (Reihenfolge = Eingang) */
export const DEMO_STATUS_COUNTS: [AntragStatus, number][] = [
  ["aufgenommen", 5],
  ["warteliste", 2],
  ["abgelehnt", 2],
  ["vollstaendig", 5],
  ["zurueckgezogen", 2],
  ["termin", 8],
  ["eingegangen", 4],
  ["unbestaetigt", 2],
];

const CHILD_FIRST = ["Emil", "Lina", "Noah", "Mila", "Paul", "Ida", "Ben", "Emma", "Finn", "Clara", "Jonas", "Lea", "Theo", "Mia", "Luis", "Hanna", "Elias", "Frieda", "Anton", "Marie", "Karl", "Greta", "Oskar", "Nele", "Henry", "Lotta", "Mats", "Alma", "Levi", "Ronja"];
const LAST = ["Albers", "Brandes", "Cramer", "Dietz", "Ebert", "Fiedler", "Grote", "Hesse", "Imhoff", "Jansen", "Kaiser", "Lorenz", "Möller", "Nolte", "Ott", "Pohl", "Quast", "Rieger", "Sander", "Thiel", "Ullrich", "Voss", "Wendt", "Yilmaz", "Zander", "Bauer", "Kuhn", "Lehmann", "Peters", "Schreiber"];
const PARENT_FIRST = ["Anja", "Markus", "Sandra", "Thomas", "Katrin", "Stefan", "Nicole", "Jan", "Melanie", "Daniel", "Julia", "Christian", "Sabrina", "Tobias", "Nadine"];
const PRIMARY = ["GGS Am Park", "Lindenschule (GGS)", "KGS St. Martin", "GGS Sonnenhügel", "GGS Regenbogen"];
const STREETS = ["Lindenweg", "Am Mühlbach", "Gartenstraße", "Birkenallee", "Schulstraße", "Ahornring", "Feldweg", "Kirchplatz"];
const PLACES: [string, string][] = [
  ["12345", "Musterstadt"],
  ["12347", "Musterstadt-Nord"],
  ["12350", "Beispielhausen"],
];

const INTRO = [
  "Anmeldung für die Klasse 5 im Schuljahr 2027/28 (Demo).",
  "",
  "Bitte bringen Sie zum Anmeldegespräch mit:",
  "- Anmeldeschein der Grundschule (Original)",
  "- Halbjahreszeugnis Klasse 4 mit begründeter Empfehlung",
  "- Geburtsurkunde bzw. Familienstammbuch",
  "- Nachweis über den Masernschutz",
  "",
  "Die Online-Anmeldung ist eine Vormerkung mit Termin – verbindlich wird sie im Gespräch.",
].join("\n");

/** nächster Werktag (Mo–Fr) ab `ymd` */
const workday = (ymd: string) => {
  let d = ymd;
  while (weekdayMon0(d) > 4) d = addDays(d, 1);
  return d;
};

export async function seedAnmeldung(db: Db, opts: { now?: Date; seed?: number } = {}) {
  const now = opts.now ?? new Date();
  const rng = createRng(opts.seed ?? 20271);
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const today = toBerlinDate(now);

  // Zielschuljahr 2027/28 (nicht aktuell) – daran hängt das Verfahren, der Schuljahreswechsel bietet es als neues Schuljahr an
  await db.insert(schoolYears).values({ id: DEMO_TARGET_YEAR_ID, name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31", isCurrent: false, term2StartsOn: "2028-02-01" });
  await db.insert(anmeldungVerfahren).values({
    id: DEMO_VERFAHREN_ID,
    name: DEMO_VERFAHREN_NAME,
    kind: "klasse5",
    targetSchoolYearId: DEMO_TARGET_YEAR_ID,
    targetGradeLevel: 5,
    opensAt: ago(21 * 24),
    closesAt: new Date(now.getTime() + 45 * 86_400_000),
    capacity: 112,
    intro: INTRO,
    fields: { geschwister: true, zweitwunsch: true, elternteil2: true, hinweise: true },
    status: "offen",
    createdBy: "u-sabine.kowalski",
    createdAt: ago(28 * 24),
    updatedAt: ago(21 * 24),
  });

  // Gesprächstage: zwei vergangene, vier künftige; 14–17 Uhr, 30 min, zwei Gespräche parallel
  const pastDays = [workday(addDays(today, -9)), workday(addDays(today, -6))].filter((d, i, a) => a.indexOf(d) === i && d < today);
  const futureDays = [7, 8, 14, 15].map((n) => workday(addDays(today, n))).filter((d, i, a) => a.indexOf(d) === i);
  const generated = generateSlots({ days: [...pastDays, ...futureDays], windows: [{ from: "14:00", to: "17:00" }], durationMinutes: 30, parallel: 2 });
  const slots = await db
    .insert(anmeldungSlots)
    .values(generated.map((s) => ({ ...s, verfahrenId: DEMO_VERFAHREN_ID, roomId: "101", note: "Sekretariat, Eingang Hauptgebäude" })))
    .returning({ id: anmeldungSlots.id, startsAt: anmeldungSlots.startsAt });
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const past = slots.filter((s) => s.startsAt < now);
  const future = slots.filter((s) => s.startsAt > now);
  // je Termin höchstens zwei Anträge (parallel = 2): der Reihe nach vergeben
  let pastAt = 0;
  let futureAt = 0;
  const nextPast = () => past[Math.floor(pastAt++ / 2) % past.length]!.id;
  const nextFuture = () => future[Math.floor(futureAt++ / 2) % future.length]!.id;

  // Geschwisterkind: ein Antrag über das Elternkonto von Lea Schäfer (7b) – zeigt die Anmeldung mit Konto (P4-34b)
  const [leaParent] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.parentId))
    .where(eq(parentChild.childId, "u-lea.schaefer"))
    .limit(1);

  // Q5-23: jeder zweite zweite Elternteil mit E-Mail-Adresse (ohne weiteren Zufallswert – die Demo-Daten bleiben gleich)
  const parent2 = (name: string | null, i: number) => ({
    parent2Name: name,
    parent2Email: name && i % 2 === 0 ? `${name.replace(/ /g, ".")}`.toLowerCase().replace(/ö/g, "oe").replace(/ä/g, "ae").replace(/ü/g, "ue").replace(/ß/g, "ss") + "@example.org" : null,
  });
  const statuses = DEMO_STATUS_COUNTS.flatMap(([s, n]) => Array.from({ length: n }, () => s));
  const sabine = "u-sabine.kowalski";
  const petra = "u-petra.lindner";
  for (const [i, status] of statuses.entries()) {
    const first = CHILD_FIRST[i]!;
    const last = LAST[i]!;
    const parentFirst = rng.pick(PARENT_FIRST);
    const [zip, city] = rng.pick(PLACES);
    // Eingang: die ersten Anträge vor ~3 Wochen, die unbestätigten erst vor wenigen Stunden
    const createdAt = status === "unbestaetigt" ? ago(2 + 5 * (i - statuses.indexOf("unbestaetigt"))) : ago((21 - Math.floor((i * 20) / statuses.length)) * 24 + rng.int(1, 10));
    const viaAccount = i === 12 && leaParent;
    const decided = (["aufgenommen", "warteliste", "abgelehnt"] as AntragStatus[]).includes(status);
    const hadTalk = decided || status === "vollstaendig";
    const slotId = hadTalk ? nextPast() : status === "termin" ? nextFuture() : null;
    const decidedAt = decided ? ago(rng.int(1, 4) * 24) : status === "zurueckgezogen" ? ago(rng.int(3, 10) * 24) : null;
    const sibling = viaAccount ? true : rng.chance(0.2);
    const [row] = await db
      .insert(anmeldungAntraege)
      .values({
        verfahrenId: DEMO_VERFAHREN_ID,
        year: 2027,
        seq: i + 1,
        status,
        childFirstName: first,
        childLastName: viaAccount ? "Schäfer" : last,
        childBirthDate: `${rng.chance(0.6) ? 2016 : 2017}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
        primarySchool: rng.pick(PRIMARY),
        sibling,
        siblingNote: viaAccount ? "Lea Schäfer, 7b" : sibling ? "Bruder in Klasse 6" : null,
        secondChoiceSchool: rng.chance(0.4) ? "Realschule Am Stadtpark" : null,
        parent1Name: viaAccount ? leaParent.name : `${parentFirst} ${last}`,
        parent1Email: viaAccount ? leaParent.email : `${parentFirst}.${last}`.toLowerCase().replace(/ö/g, "oe") + "@example.org",
        parent1Phone: rng.chance(0.7) ? `0123 ${rng.int(100000, 999999)}` : null,
        addressStreet: `${rng.pick(STREETS)} ${rng.int(1, 80)}`,
        addressZip: zip,
        addressCity: city,
        ...parent2(rng.chance(0.5) ? `${rng.pick(PARENT_FIRST)} ${last}` : null, i),
        hints: i === 3 ? "Wir sind erst im Sommer zugezogen." : null,
        slotId,
        consentAt: createdAt,
        confirmExpiresAt: status === "unbestaetigt" ? new Date(createdAt.getTime() + 48 * 3_600_000) : null,
        confirmedAt: status === "unbestaetigt" ? null : new Date(createdAt.getTime() + 20 * 60_000),
        checklist: hadTalk ? Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])) : {},
        decisionNote: status === "warteliste" ? "Nachrücken möglich" : null,
        decidedAt,
        decidedBy: decided ? petra : null,
        parentUserId: viaAccount ? leaParent.id : null,
        // wie die Statusmaschine: unbestätigt ab Eingang, zurückgezogen ab Rücknahme; Entscheidungen erst ab Verfahrensabschluss
        retentionFrom: status === "unbestaetigt" ? createdAt : status === "zurueckgezogen" ? decidedAt : null,
        createdAt,
        updatedAt: decidedAt ?? createdAt,
      })
      .returning({ id: anmeldungAntraege.id });
    const id = row!.id;
    const events: (typeof anmeldungEreignisse.$inferInsert)[] = [
      { antragId: id, at: createdAt, actorId: viaAccount ? leaParent.id : null, kind: "eingegangen", text: viaAccount ? "Elternkonto" : "Online-Formular" },
    ];
    if (status !== "unbestaetigt" && !viaAccount) events.push({ antragId: id, at: new Date(createdAt.getTime() + 20 * 60_000), actorId: null, kind: "bestaetigt", text: "E-Mail bestätigt" });
    if (hadTalk) events.push({ antragId: id, at: ago(5 * 24), actorId: sabine, kind: "status", text: `${L.termin} → ${L.vollstaendig}` });
    if (decided) events.push({ antragId: id, at: decidedAt!, actorId: petra, kind: "status", text: `${L.vollstaendig} → ${L[status]}` });
    if (status === "zurueckgezogen") events.push({ antragId: id, at: decidedAt!, actorId: null, kind: "status", text: `${L.eingegangen} → ${L.zurueckgezogen}` });
    await db.insert(anmeldungEreignisse).values(events);
  }
}
