import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "@/core/db/client";
import {
  accounts,
  appSettings,
  grants,
  groupMembers,
  groups,
  parentChild,
  periods,
  rooms,
  schoolClosures,
  schoolYears,
  subjects,
  users,
  type GroupKind,
  type NewUser,
  type Role,
} from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { setModuleEnabled, syncDefaultGrants } from "@/core/modules/registry";
import { setSchoolLogo } from "@/core/school/logo";
import { SUBJECT_TEMPLATE, defaultTimeGrid } from "@/core/school/templates";
import { MODULES } from "@/modules";
import { seedAufgaben } from "@/modules/aufgaben/seed";
import { seedBuchungen } from "@/modules/buchungen/seed";
import buecherei from "@/modules/buecherei/manifest";
import { seedBuecherei, seedLernmittel } from "@/modules/buecherei/seed";
import { seedDateien } from "@/modules/dateien/seed";
import { seedElternbriefe } from "@/modules/elternbriefe/seed";
import anmeldung from "@/modules/anmeldung/manifest";
import { seedAnmeldung } from "@/modules/anmeldung/seed";
import gebaeude from "@/modules/gebaeude/manifest";
import notenbuch from "@/modules/notenbuch/manifest";
import { seedGebaeude } from "@/modules/gebaeude/seed";
import { seedKalender } from "@/modules/kalender/seed";
import { seedKlassenbuch } from "@/modules/klassenbuch/seed";
import { seedKlausurplan } from "@/modules/klausurplan/seed";
import { seedMonitor } from "@/modules/monitor/seed";
import { seedMessenger } from "@/modules/messenger/seed";
import { seedForen } from "@/modules/foren/seed";
import { seedPinnwaende } from "@/modules/pinnwaende/seed";
import { seedTafeln } from "@/modules/tafeln/seed";
import { seedTexte } from "@/modules/texte/seed";
import { seedNews } from "@/modules/news/seed";
import { seedStundenplan } from "@/modules/stundenplan/seed";
import { PLAN_SUBSTITUTE, PLANNING_GROUP, PLANNING_GROUP_PERMISSIONS } from "@/modules/stundenplan/rechte";
import { applyCurriculumTemplate, ensureGradeLevels } from "@/modules/verwaltung/stammdaten";
import { LINDENHOF_LOGO_DARK_SVG, LINDENHOF_LOGO_SVG, LINDENHOF_SYMBOL_SVG } from "./lindenhof-logo";
import {
  AGS,
  CLASSES,
  DEMO_CLOSURES,
  DEMO_IMPRESSUM,
  DEMO_PASSWORD,
  FIRST_NAMES,
  LAST_NAMES,
  PARENT_FIRST_NAMES,
  ROOMS,
  SCHOOL_COLOR,
  SCHOOL_NAME,
  TEACHERS,
  UPPER_GRADES,
} from "./data";
import { createRng, toUsername } from "./rng";

type MemberRow = { groupId: string; userId: string; role: "member" | "leader" };
type GroupRow = {
  id: string;
  name: string;
  slug: string;
  kind: GroupKind;
  gradeLevel?: number;
  level?: string;
  subjectId?: string;
  schoolYearId?: string;
  ownerId?: string;
  description?: string;
};

export interface SeedSummary {
  users: number;
  byRole: Record<Role, number>;
  groups: number;
  memberships: number;
}

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, size = 400) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/**
 * Erzeugt die komplette Demo-Schule in einer LEEREN, migrierten Datenbank.
 * Deterministisch: gleicher Seed → identische Daten (IDs, Namen, Zuordnungen).
 */
/**
 * `closures: false` lässt die Demo-Ferien weg (E2E: Tests sollen nicht davon abhängen, ob das echte Datum
 * gerade in den Herbstferien liegt). Gesetzliche Feiertage gelten trotzdem – sie werden berechnet.
 * `admissions: false` lässt das Demo-Anmeldeverfahren samt Schuljahr 2027/28 weg (E2E: die Specs legen eigene Verfahren an
 * und erwarten „Folgejahr anlegen“ im Schuljahreswechsel; der volle Durchlauf kommt mit P4-43).
 * `substitutionRelease: false` lässt den Vertretungsplan auf der Vorgabe „sofort“ (Service-Tests); die Demo-Schule zeigt
 * „erst nach Freigabe“ (Q5-11, F-06).
 */
export async function seedDemoSchool(
  db: Db,
  opts: { seed?: number; passwordHash?: string; closures?: boolean; admissions?: boolean; substitutionRelease?: boolean; storage?: FileStorage } = {},
): Promise<SeedSummary> {
  const rng = createRng(opts.seed ?? 20261003);
  const passwordHash = opts.passwordHash ?? (await hashPassword(DEMO_PASSWORD));

  const userRows: NewUser[] = [];
  const usernames = new Set<string>();
  function addUser(first: string, last: string, role: Role, extra: Partial<NewUser> = {}, fixedUsername?: string) {
    const base = fixedUsername ?? toUsername(first, last);
    let username = base;
    for (let n = 2; usernames.has(username); n++) username = `${base}${n}`;
    usernames.add(username);
    const id = `u-${username}`;
    userRows.push({
      id,
      name: `${first} ${last}`.trim(),
      firstName: first,
      lastName: last,
      username,
      displayUsername: username,
      email: `${username}@lindenhof.schulos.local`,
      role,
      ...extra,
    });
    return id;
  }

  const groupRows: GroupRow[] = [];
  const members: MemberRow[] = [];
  const addMember = (groupId: string, userId: string, role: MemberRow["role"] = "member") => {
    if (!members.some((m) => m.groupId === groupId && m.userId === userId)) members.push({ groupId, userId, role });
  };

  // --- Stammdaten
  const yearId = "sj-2026-27";
  await db.insert(schoolYears).values({ id: yearId, name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31", isCurrent: true, term2StartsOn: "2027-02-01" });
  // Fächer, Zeitraster und Stundentafel kommen aus denselben Vorlagen, die auch eine echte Schule übernimmt
  await db.insert(subjects).values(SUBJECT_TEMPLATE.map((s, i) => ({ ...s, sortOrder: i })));
  await db.insert(rooms).values(ROOMS);
  await db.insert(periods).values(defaultTimeGrid({ form: "gesamtschule" }).periods);
  if (opts.closures !== false) await db.insert(schoolClosures).values(DEMO_CLOSURES);
  await db.insert(appSettings).values([
    { key: "school.name", value: SCHOOL_NAME },
    { key: "school.color", value: SCHOOL_COLOR },
    { key: "school.number", value: "199999" },
    { key: "school.state", value: "NW" },
    { key: "school.form", value: "gesamtschule" },
    { key: "school.oberstufe", value: true },
    { key: "school.abitur", value: "g9" },
    { key: "demo", value: true },
    { key: "school.impressum.fields", value: DEMO_IMPRESSUM },
    // Q5-11 (F-06): die Demo zeigt den Vertretungsplan mit Freigabe (Vorgabe für echte Schulen bleibt „sofort“)
    ...(opts.substitutionRelease !== false ? [{ key: "module.stundenplan.substitution_release", value: "freigabe" }] : []),
  ]);

  await ensureGradeLevels(db);
  await applyCurriculumTemplate(db, null);

  // --- Personal
  addUser("Admin", "IT", "admin", {}, "admin");
  addUser("Sabine", "Kowalski", "verwaltung"); // Sekretariat – Rechte über die Rolle, NICHT Teil der Schulleitung
  // Hausmeister (Rolle „personal“, P4-10): Rechte für Gebäude & Technik über die Gruppe „Hausmeisterei“
  const hausmeister = addUser("Klaus", "Berger", "personal");
  // Schulsozialarbeit (Rolle „beratung“, Q5-17): für Schüler:innen und Eltern mit Sprechzeiten im Adressbuch; Chat bleibt
  // aus (Moduleinstellung, erst nach DSB-Votum)
  addUser("Nina", "Ostermann", "beratung", { officeHours: "Di und Do 9–13 Uhr, Raum A 0.14 (neben dem Sekretariat)" });
  const teacherIds = new Map<string, string>();
  for (const [first, last, code] of TEACHERS) {
    teacherIds.set(code, addUser(first, last, "lehrkraft", { shortCode: code }));
  }
  const teacher = (code: string) => teacherIds.get(code)!;
  const allTeachers = [...teacherIds.values()];

  // --- Schüler:innen + Eltern
  const parentsByLastName = new Map<string, string[]>();
  const children: { parentId: string; childId: string }[] = [];
  function addStudent(first: string, last: string) {
    const id = addUser(first, last, "schueler");
    const siblings = parentsByLastName.get(last);
    let parentId: string;
    if (siblings && rng.chance(0.35)) {
      parentId = rng.pick(siblings);
    } else {
      parentId = addUser(rng.pick(PARENT_FIRST_NAMES), last, "eltern");
      parentsByLastName.set(last, [...(siblings ?? []), parentId]);
    }
    children.push({ parentId, childId: id });
    return id;
  }

  const sek1Students: string[] = [];
  const classLeaderPool = allTeachers.filter((t) => t !== teacher("BRA") && t !== teacher("LIN"));
  CLASSES.forEach(({ grade, letter }, i) => {
    const slug = `${grade}${letter}`;
    const groupId = `g-${slug}`;
    groupRows.push({ id: groupId, name: `Klasse ${slug}`, slug, kind: "klasse", gradeLevel: grade, schoolYearId: yearId });
    const leader = slug === "7b" ? teacher("BRA") : classLeaderPool[i % classLeaderPool.length]!;
    addMember(groupId, leader, "leader");
    for (let k = 0; k < 3; k++) addMember(groupId, rng.pick(allTeachers));
    for (let n = 0; n < 25; n++) {
      // Lea Schäfer (7b) ist die feste Demo-Schülerin aus dem UI-Konzept.
      const id = slug === "7b" && n === 0 ? addStudent("Lea", "Schäfer") : addStudent(rng.pick(FIRST_NAMES), rng.pick(LAST_NAMES));
      addMember(groupId, id);
      sek1Students.push(id);
    }
  });

  const upperStudents = new Map<string, string[]>();
  const upperSizes: Record<string, number> = { ef: 22, q1: 20, q2: 18 };
  UPPER_GRADES.forEach(({ slug, name, grade }, i) => {
    const groupId = `g-${slug}`;
    groupRows.push({ id: groupId, name, slug, kind: "klasse", gradeLevel: grade, schoolYearId: yearId });
    addMember(groupId, classLeaderPool[(CLASSES.length + i) % classLeaderPool.length]!, "leader");
    const ids: string[] = [];
    for (let n = 0; n < upperSizes[slug]!; n++) {
      const id = addStudent(rng.pick(FIRST_NAMES), rng.pick(LAST_NAMES));
      addMember(groupId, id);
      ids.push(id);
    }
    upperStudents.set(slug, ids);
  });

  // --- Oberstufenkurse
  const courses: [string, string, string, string][] = [
    ["ef", "D", "GK1", "BRA"],
    ["ef", "M", "GK1", "POP"],
    ["q1", "E", "GK1", "BRA"],
    ["q1", "M", "LK1", "KLE"],
    ["q1", "D", "GK1", "WEB"],
    ["q1", "BI", "GK1", "OKA"],
    ["q2", "E", "LK1", "WAG"],
    ["q2", "PH", "GK1", "SLT"],
  ];
  for (const [grade, subjectId, label, code] of courses) {
    const subject = SUBJECT_TEMPLATE.find((s) => s.id === subjectId)!;
    const slug = `${grade}-${subjectId.toLowerCase()}-${label.toLowerCase()}`;
    const groupId = `g-${slug}`;
    const gradeLevel = UPPER_GRADES.find((g) => g.slug === grade)!.grade;
    groupRows.push({ id: groupId, name: `${grade.toUpperCase()} ${subject.name} ${label}`, slug, kind: "kurs", gradeLevel, level: label.startsWith("LK") ? "LK" : "GK", subjectId, schoolYearId: yearId });
    addMember(groupId, teacher(code), "leader");
    for (const s of upperStudents.get(grade)!) if (rng.chance(0.7)) addMember(groupId, s);
  }

  // --- Fachschaften
  for (const s of SUBJECT_TEMPLATE) {
    const groupId = `g-fs-${s.id.toLowerCase()}`;
    groupRows.push({ id: groupId, name: `Fachschaft ${s.name}`, slug: `fs-${s.id.toLowerCase()}`, kind: "fachschaft", subjectId: s.id });
    TEACHERS.filter(([, , , subs]) => subs.includes(s.id)).forEach(([, , code], i) => addMember(groupId, teacher(code), i === 0 ? "leader" : "member"));
  }

  // --- Gremien
  groupRows.push({ id: "g-schulleitung", name: "Schulleitung", slug: "schulleitung", kind: "gremium" });
  addMember("g-schulleitung", teacher("LIN"), "leader");
  addMember("g-schulleitung", teacher("KLE"));

  groupRows.push({ id: "g-lehrerkonferenz", name: "Lehrerkonferenz", slug: "lehrerkonferenz", kind: "gremium" });
  for (const t of allTeachers) addMember("g-lehrerkonferenz", t, t === teacher("LIN") ? "leader" : "member");

  groupRows.push({ id: "g-sv", name: "Schülervertretung", slug: "sv", kind: "gremium" });
  addMember("g-sv", teacher("DEM"), "leader");
  for (let i = 0; i < CLASSES.length; i++) addMember("g-sv", sek1Students[i * 25 + 1]!);

  groupRows.push({ id: "g-schulkonferenz", name: "Schulkonferenz", slug: "schulkonferenz", kind: "gremium" });
  addMember("g-schulkonferenz", teacher("LIN"), "leader");
  for (const code of ["BRA", "KLE", "DEM"]) addMember("g-schulkonferenz", teacher(code));
  for (const c of children.slice(0, 3)) addMember("g-schulkonferenz", c.parentId);
  for (let i = 0; i < 3; i++) addMember("g-schulkonferenz", sek1Students[250 + i * 10]!);

  groupRows.push({ id: "g-hausmeisterei", name: "Hausmeisterei", slug: "hausmeisterei", kind: "frei" });
  addMember("g-hausmeisterei", hausmeister);

  // Funktionsgruppe Stundenplanung (SP-02, Q-SP-8): legt Migration 0088 an – nach demo-reset (alle Tabellen leer) die Demo selbst.
  // Frank Schulte (SLT, Lehrkraft PH/IF, weder Schulleitung noch Klassenleitung der 7b) plant.
  const [planningGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, PLANNING_GROUP.id));
  if (!planningGroup) groupRows.push({ id: PLANNING_GROUP.id, name: PLANNING_GROUP.name, slug: PLANNING_GROUP.slug, kind: "gremium", description: PLANNING_GROUP.description });
  addMember(PLANNING_GROUP.id, teacher("SLT"), "leader");

  // Schulbücherei (BU-01): Team aus einer Lehrkraft und zwei Schüler-Helfer:innen – Theke und Bestand über die Gruppe
  groupRows.push({ id: "g-buecherei", name: "Büchereiteam", slug: "buechereiteam", kind: "frei" });
  addMember("g-buecherei", teacher("DEM"), "leader");
  addMember("g-buecherei", sek1Students[40]!);
  addMember("g-buecherei", sek1Students[90]!);

  // --- AGs
  for (const ag of AGS) {
    const groupId = `g-${ag.slug}`;
    groupRows.push({ id: groupId, name: ag.name, slug: ag.slug, kind: "ag", schoolYearId: yearId });
    addMember(groupId, teacher(ag.leader), "leader");
    const size = rng.int(8, 15);
    for (let n = 0; n < size; n++) addMember(groupId, rng.pick(sek1Students));
  }
  // Lea ist in der Schülerzeitung.
  addMember("g-ag-schuelerzeitung", "u-lea.schaefer");

  // --- Schreiben
  await insertChunked(userRows, (c) => db.insert(users).values(c));
  await insertChunked(
    userRows.map((u) => ({ id: `acc-${u.id}`, accountId: u.id!, providerId: "credential", userId: u.id!, password: passwordHash })),
    (c) => db.insert(accounts).values(c),
  );
  await insertChunked(children, (c) => db.insert(parentChild).values(c));
  await insertChunked(groupRows.map((g) => ({ ...g, ownerId: g.ownerId ?? null })), (c) => db.insert(groups).values(c));
  await insertChunked(members, (c) => db.insert(groupMembers).values(c));

  await syncDefaultGrants(db, MODULES);
  await db.insert(grants).values([
    { permission: "verwaltung.*", groupId: "g-schulleitung" },
    { permission: "news.manage", groupId: "g-schulleitung" },
    { permission: "kalender.school", groupId: "g-schulleitung" },
    { permission: "klassenbuch.view_all", groupId: "g-schulleitung" },
    { permission: "elternbriefe.send_all", groupId: "g-schulleitung" },
    { permission: "klausurplan.manage", groupId: "g-schulleitung" },
    { permission: "gebaeude.manage", groupId: "g-hausmeisterei" },
    { permission: "buecherei.desk", groupId: "g-buecherei" },
    { permission: "buecherei.stock", groupId: "g-buecherei" },
    // Schulanmeldung (P4-32): die Schulleitung entscheidet (§ 46 SchulG NRW), das Sekretariat bearbeitet über die Rolle
    { permission: "anmeldung.decide", groupId: "g-schulleitung" },
    { permission: "anmeldung.view", groupId: "g-schulleitung" },
    // Beurlaubung über der Grenze (Q5-16): entscheidet die Schulleitung
    { permission: "abwesenheiten.leave_decide", groupId: "g-schulleitung" },
    // P4-74/I-26: selbst gemeldete Fortbildung/dienstliche Abwesenheit von Lehrkräften genehmigt die Schulleitung
    { permission: "stundenplan.absence_approve", groupId: "g-schulleitung" },
    // Notenbuch (P5-11): Halbjahreswerte, Übertragen, Export – nie Teilnoten
    { permission: "notenbuch.term_view", groupId: "g-schulleitung" },
    { permission: "notenbuch.transfer", groupId: "g-schulleitung" },
    { permission: "notenbuch.export", groupId: "g-schulleitung" },
    { permission: "notenbuch.unlock", groupId: "g-schulleitung" },
    // G5A-S01: Notenbuch-Teil der Auskunft (Art. 15) – ausdrücklich, kein Admin-Override
    { permission: "notenbuch.auskunft", groupId: "g-schulleitung" },
    // SP-02 (Q-SP-8, FEINSCHLIFF I-27): Schulleitung sieht Vertretungsbedarf, Entwürfe und „Offen für dich“ – plant aber nicht
    { permission: PLAN_SUBSTITUTE, groupId: "g-schulleitung" },
  ]);
  // Rechte der Funktionsgruppe (Migration 0088 legt sie schon an, nach demo-reset fehlen sie)
  await db
    .insert(grants)
    .values(PLANNING_GROUP_PERMISSIONS.map((permission) => ({ permission, groupId: PLANNING_GROUP.id })))
    .onConflictDoNothing();
  // SP-03: Das Sekretariat plant in der Demo nicht mehr – geplant wird unter /planung über die Gruppe „Stundenplanung“
  // (frank.schulte). Migration 0088 legt auf frischer DB keinen Rollen-Grant an; ein alter aus einer Bestands-DB bleibt unberührt.
  await seedNews(db);
  await seedKalender(db);
  await seedDateien(db);
  await seedMessenger(db);
  await seedForen(db);
  await seedPinnwaende(db);
  await seedTexte(db);
  await seedAufgaben(db);
  await seedStundenplan(db);
  await seedKlassenbuch(db);
  await seedElternbriefe(db);
  await seedBuchungen(db);
  await seedKlausurplan(db);
  await seedMonitor(db);
  // neue Module kommen per Update ausgeschaltet (B-34) – die Demo zeigt Gebäude & Technik eingeschaltet
  await setModuleEnabled(db, gebaeude, true);
  // Schulanmeldung: in der Demo an (ohne SMTP bleiben Mails in der Warteschlange), offenes Verfahren mit 30 Anträgen (P4-41)
  await setModuleEnabled(db, anmeldung, true);
  if (opts.admissions !== false) await seedAnmeldung(db);
  // Notenbuch (P5-12): in der Demo an – echte Schulen schalten es erst nach VVT/DSB-Prüfung ein (DSB-FRAGEN §15); Demo-Instanzen
  // verlangen wie beim Kern keine Zwei-Faktor-Anmeldung (Q-5A-4)
  await setModuleEnabled(db, notenbuch, true);
  await seedGebaeude(db, { groupId: "g-hausmeisterei", hausmeisterId: hausmeister });
  // Schulbücherei (BU-01): bis GATE BU1 ab Werk aus, in der Demo an
  await setModuleEnabled(db, buecherei, true);
  await seedBuecherei(db, { borrowers: [sek1Students[3]!, sek1Students[30]!, sek1Students[60]!] });
  // Schulbuchausleihe (BU-10): ab Werk aus, in der Demo an
  await seedLernmittel(db);
  // Demo-Logo (P4-05) – nur mit Dateispeicher (db:reset, Erststart, demo-reset); Tests ohne Speicher bleiben ohne Logo
  if (opts.storage) {
    const svg = (s: string) => new TextEncoder().encode(s);
    await setSchoolLogo(db, opts.storage, null, "logo", svg(LINDENHOF_LOGO_SVG));
    await setSchoolLogo(db, opts.storage, null, "dark", svg(LINDENHOF_LOGO_DARK_SVG));
    await setSchoolLogo(db, opts.storage, null, "symbol", svg(LINDENHOF_SYMBOL_SVG));
    // Beispieltafel im Gruppenordner der 7b (P3-12) – eine Tafel ist eine Datei, braucht also den Speicher
    await seedTafeln(db, opts.storage);
  }

  const byRole = { schueler: 0, lehrkraft: 0, eltern: 0, personal: 0, beratung: 0, verwaltung: 0, admin: 0 } satisfies Record<Role, number>;
  for (const u of userRows) byRole[u.role!]++;
  return { users: userRows.length, byRole, groups: groupRows.length + (planningGroup ? 1 : 0), memberships: members.length };
}
