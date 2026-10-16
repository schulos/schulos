// Übernahme aufgenommener Kinder im Schuljahreswechsel (P4-39, Schritt „Neuaufnahmen“): neue Klassen des Zieljahrgangs
// im neuen Schuljahr anlegen, Kinder zuordnen (Grundschule und Geschwister nur als Sortierhilfe), Konten für Kind und
// Elternteil 1 (und Elternteil 2, falls mit E-Mail angegeben – Q5-23) erzeugen wie beim CSV-Import (Benutzername `vorname.nachname`, Startpasswort, Passwortwechsel-Pflicht) bzw. ein
// vorhandenes Elternkonto verknüpfen, Antrag → „übernommen“ (Fristbeginn LK-90). Zugangsdaten gibt es einmalig als Liste
// (CSV/Druck) – **nicht** per Mail (Startpasswort auf Papier, wie beim Import). Übernommen werden nur die Minimaldaten
// (Name, Klasse, E-Mail des Elternteils); alles Weitere bleibt in der Schulverwaltungssoftware (PHASE4 §3.3).
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { generatePassword } from "@schulos/server/passwort";
import { audit } from "@/core/audit";
import { normalizeEmail, placeholderEmail } from "@/core/auth/email";
import { toCsv } from "@/core/csv";
import type { Db } from "@/core/db/client";
import {
  accounts,
  anmeldungAntraege,
  anmeldungEreignisse,
  anmeldungVerfahren,
  gradeLevels,
  groupMembers,
  groups,
  parentChild,
  schoolYears,
  schoolYearTransitions,
  sessions,
  users,
} from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { endLiveStreams } from "@/core/notifications/bus";
import { toUsername } from "@/core/seed/rng";
import { slugify } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { ANTRAG_STATUS_LABELS } from "./labels";
import { antragNumber, retentionFromFor } from "./service";

/** Richtwert für Vorschläge: so viele Kinder je neuer Klasse (Klassenfrequenzrichtwert NRW Sek I: 27, Bandbreite 25–29). */
export const CLASS_SIZE_HINT = 27;
/** Wert für „nicht übernehmen“ in der Zuordnung. */
export const SKIP = "nicht";

export interface AdmissionCandidate {
  antragId: string;
  number: string;
  verfahrenName: string;
  gradeLevel: number;
  childFirstName: string;
  childLastName: string;
  childBirthDate: string;
  primarySchool: string | null;
  sibling: boolean;
  siblingNote: string | null;
  parent1Name: string;
  /** normalisierte Adresse (Kleinbuchstaben) */
  parent1Email: string;
  /** vorhandenes Elternkonto: Antrag über das Konto (P4-34b) oder gleiche, bestätigte E-Mail an einem Elternkonto */
  existingParent: { id: string; name: string; username: string | null; via: "konto" | "email" | "vorschlag" } | null;
  /**
   * Q5-20: aktives Elternkonto mit derselben, aber **unbestätigten** E-Mail – nur ein Vorschlag; verknüpft wird es erst, wenn
   * die Verwaltung es ankreuzt (`AdmissionInput.linkSuggested`), sonst entsteht ein neues Elternkonto.
   */
  suggestedParent: { id: string; name: string; username: string | null } | null;
  /**
   * Q5-23: zweiter Elternteil – nur, wenn im Antrag mit E-Mail angegeben (sonst kein Konto). GATE-031 (S-01): Die Adresse hat
   * die antragstellende Person eingetragen, Elternteil 2 hat sie nie bestätigt – darum wird **nie automatisch** verknüpft.
   * Ein Treffer ist nur ein Vorschlag zum Ankreuzen (`AdmissionInput.linkSuggested2`): ein aktives Elternkonto mit dieser
   * Adresse (`konto`) oder ein anderer aufgenommener Antrag, in dem die Adresse als Elternteil 1 bestätigt ist (`antrag`,
   * z. B. Geschwister mit vertauschten Rollen). Ohne Haken entsteht ein neues Konto mit Platzhalter-Adresse.
   */
  parent2: {
    name: string;
    /** normalisierte Adresse (unbestätigt) */
    email: string;
    suggestion:
      | { kind: "konto"; id: string; name: string; username: string | null; verified: boolean }
      | { kind: "antrag"; number: string; name: string }
      | null;
  } | null;
}

/**
 * Aufgenommene Anträge aller Verfahren mit diesem Zielschuljahr – sortiert nach Jahrgang, Grundschule, Name (deutsch).
 * Leer, wenn es keine gibt (dann entfällt der Schritt).
 */
export async function pendingAdmissions(db: Db, toYearId: string): Promise<AdmissionCandidate[]> {
  const rows = await db
    .select({ a: anmeldungAntraege, verfahrenName: anmeldungVerfahren.name, gradeLevel: anmeldungVerfahren.targetGradeLevel })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .where(and(eq(anmeldungVerfahren.targetSchoolYearId, toYearId), eq(anmeldungAntraege.status, "aufgenommen")))
    .orderBy(asc(anmeldungVerfahren.targetGradeLevel), de(anmeldungAntraege.primarySchool), de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName));
  if (!rows.length) return [];
  const mails = [...new Set(rows.flatMap((r) => [normalizeEmail(r.a.parent1Email).email, r.a.parent2Email ? normalizeEmail(r.a.parent2Email).email : null]).filter((e): e is string => Boolean(e)))];
  const accountIds = [...new Set(rows.map((r) => r.a.parentUserId).filter((x): x is string => Boolean(x)))];
  const known = await db
    .select({ id: users.id, name: users.name, username: users.username, email: users.email, emailVerified: users.emailVerified, status: users.status })
    .from(users)
    .where(and(eq(users.role, "eltern"), isNull(users.leftOn)))
    .then((all) => all.filter((u) => accountIds.includes(u.id) || mails.includes(u.email)));
  return rows.map(({ a, verfahrenName, gradeLevel }) => {
    const email = normalizeEmail(a.parent1Email).email ?? a.parent1Email.trim().toLowerCase();
    const byAccount = a.parentUserId ? known.find((u) => u.id === a.parentUserId && u.status === "active") : undefined;
    // GATE-4c: per E-Mail nur mit bestätigter Adresse verknüpfen – ein Tippfehler der Verwaltung am Elternkonto gäbe sonst
    // einer fremden Familie Zugriff auf das neue Kind (dann wird ein neues Elternkonto angelegt; zusammenführen geht später)
    const byMail = byAccount ? undefined : known.find((u) => u.email === email && u.status === "active" && u.emailVerified);
    const p = byAccount ?? byMail;
    // Q5-20: unbestätigte Treffer nur als Vorschlag zum Ankreuzen
    const suggested = p ? undefined : known.find((u) => u.email === email && u.status === "active" && !u.emailVerified);
    // Q5-23: Elternteil 2 nur mit Namen und E-Mail; dieselbe Adresse wie Elternteil 1 bzw. dessen Konto zählt nicht doppelt
    const email2 = a.parent2Email && a.parent2Name ? (normalizeEmail(a.parent2Email).email ?? a.parent2Email.trim().toLowerCase()) : null;
    const konto2 = email2 ? (known.find((u) => u.email === email2 && u.status === "active" && u.emailVerified) ?? known.find((u) => u.email === email2 && u.status === "active")) : undefined;
    const sameAsParent1 = !email2 || email2 === email || (konto2 && konto2.id === (p ?? suggested)?.id);
    // S-01: andere Anträge, in denen diese Adresse als Elternteil 1 (bestätigt) steht
    const sibling2 = email2 && !konto2 ? rows.find((r) => r.a.id !== a.id && (normalizeEmail(r.a.parent1Email).email ?? r.a.parent1Email.trim().toLowerCase()) === email2) : undefined;
    return {
      antragId: a.id,
      number: antragNumber(a.year, a.seq),
      verfahrenName,
      gradeLevel,
      childFirstName: a.childFirstName,
      childLastName: a.childLastName,
      childBirthDate: a.childBirthDate,
      primarySchool: a.primarySchool,
      sibling: a.sibling,
      siblingNote: a.siblingNote,
      parent1Name: a.parent1Name,
      parent1Email: email,
      existingParent: p ? { id: p.id, name: p.name, username: p.username, via: byAccount ? "konto" : "email" } : null,
      suggestedParent: suggested ? { id: suggested.id, name: suggested.name, username: suggested.username } : null,
      parent2:
        email2 && !sameAsParent1
          ? {
              name: a.parent2Name!,
              email: email2,
              suggestion: konto2
                ? { kind: "konto", id: konto2.id, name: konto2.name, username: konto2.username, verified: konto2.emailVerified }
                : sibling2
                  ? { kind: "antrag", number: antragNumber(sibling2.a.year, sibling2.a.seq), name: sibling2.a.parent1Name }
                  : null,
            }
          : null,
    };
  });
}

/** Rein: Vorschlag Klassennamen eines Jahrgangs, z. B. „5a, 5b, 5c“ für 70 Kinder (Richtwert 27). */
export function proposeClassNames(code: string, count: number, size = CLASS_SIZE_HINT): string[] {
  const n = Math.max(1, Math.ceil(count / size));
  return Array.from({ length: Math.min(n, 26) }, (_, i) => `${code}${String.fromCharCode(97 + i)}`);
}

/**
 * Rein: Vorschlag der Zuordnung – Kinder derselben Familie (gleiche E-Mail, z. B. Zwillinge) bleiben zusammen, sonst
 * reihum in die gerade kleinste Klasse in der Reihenfolge Grundschule/Name (mischt Grundschulen gleichmäßig). Nur ein
 * Vorschlag; die Verwaltung ändert ihn vor dem Übernehmen.
 */
export function proposeAssignment(candidates: readonly Pick<AdmissionCandidate, "antragId" | "parent1Email">[], classNames: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!classNames.length) return out;
  const families = new Map<string, string[]>();
  for (const c of candidates) families.set(c.parent1Email, [...(families.get(c.parent1Email) ?? []), c.antragId]);
  const size = new Map(classNames.map((n) => [n, 0]));
  for (const ids of families.values()) {
    const target = classNames.reduce((best, n) => (size.get(n)! < size.get(best)! ? n : best), classNames[0]!);
    for (const id of ids) out[id] = target;
    size.set(target, size.get(target)! + ids.length);
  }
  return out;
}

export interface AdmissionInput {
  /** je Jahrgang die Kurznamen der Klassen („5a, 5b“) */
  classes: Record<number, string[]>;
  /** je Antrag Kurzname der Klasse oder SKIP */
  assign: Record<string, string>;
  /** GATE-4c (Code-M4): bewusst niemanden übernehmen (z. B. alle Zusagen zurückgenommen) – Schritt ohne Konten abschließen */
  skipAll?: boolean;
  /**
   * Q5-20: Anträge, deren vorgeschlagenes Elternkonto (unbestätigte E-Mail) verknüpft werden soll. Der Vorschlag selbst wird
   * serverseitig neu ermittelt – hier steht nur die Antrags-ID, nie eine Konto-ID.
   */
  linkSuggested?: readonly string[];
  /** Q5-23: wie `linkSuggested`, für den Vorschlag beim zweiten Elternteil */
  linkSuggested2?: readonly string[];
}

export interface AdmissionCredential {
  art: "Schüler:in" | "Elternteil";
  name: string;
  klasse: string;
  username: string;
  /** leer bei vorhandenen Elternkonten (Zugang besteht schon) */
  password: string;
  /** bei Eltern: Name des Kindes */
  kind: string;
}

export interface AdmissionResult {
  classes: number;
  students: number;
  parentsCreated: number;
  parentsLinked: number;
  /** davon über einen angekreuzten Vorschlag (unbestätigte E-Mail, Q5-20) */
  parentsSuggestedLinked: number;
  skipped: number;
  credentials: AdmissionCredential[];
}

/** Rein: „Andrea Beispiel“ → Vor-/Nachname; ein einzelnes Wort bekommt den Nachnamen des Kindes. */
export function splitParentName(full: string, childLastName: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1)! };
  return { firstName: parts[0] ?? "Elternteil", lastName: childLastName };
}

const normalizeClassNames = (names: readonly string[]) => [...new Set(names.map((n) => n.trim()).filter(Boolean))];

/**
 * Schritt „Neuaufnahmen“ ausführen. Erst nach der Versetzung (sonst liegen die Kurznamen der alten Klassen noch quer) und
 * nur einmal je Durchlauf. Alles in einer Transaktion; Startpasswörter einmalig im Ergebnis.
 */
export async function admitStudents(db: Db, actorId: string, transitionId: string, input: AdmissionInput, now = new Date()): Promise<AdmissionResult> {
  const [t] = await db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, transitionId));
  if (!t || t.completedAt) throw new ValidationError({ transition: "Schuljahreswechsel nicht gefunden oder abgeschlossen" });
  if (!t.promotedAt) throw new ValidationError({ transition: "Erst die Versetzung durchführen – danach sind die Kurznamen der neuen Klassen frei" });
  if (t.admittedAt) throw new ValidationError({ transition: "Die Neuaufnahmen sind bereits übernommen" });
  const [from] = await db.select().from(schoolYears).where(eq(schoolYears.id, t.fromYearId));
  const candidates = await pendingAdmissions(db, t.toYearId);
  if (!candidates.length) throw new ValidationError({ transition: "Keine aufgenommenen Anträge für dieses Schuljahr" });
  const levels = await db.select().from(gradeLevels);
  if (input.skipAll) {
    // ohne Konten: Schritt als erledigt markieren, Anträge bleiben „aufgenommen“ und gehen mit dem Verfahren in die Löschfrist
    const done = await db
      .update(schoolYearTransitions)
      .set({ admittedAt: now })
      .where(and(eq(schoolYearTransitions.id, t.id), isNull(schoolYearTransitions.admittedAt)))
      .returning({ id: schoolYearTransitions.id });
    if (!done.length) throw new ValidationError({ transition: "Die Neuaufnahmen sind bereits übernommen" });
    const result: AdmissionResult = { classes: 0, students: 0, parentsCreated: 0, parentsLinked: 0, parentsSuggestedLinked: 0, skipped: candidates.length, credentials: [] };
    await audit(db, actorId, "verwaltung.schuljahreswechsel.neuaufnahmen", null, { klassen: 0, schueler: 0, eltern_neu: 0, eltern_verknuepft: 0, nicht_uebernommen: candidates.length });
    return result;
  }

  // Klassen je Jahrgang prüfen
  const fe: Record<string, string> = {};
  const classesByLevel = new Map<number, string[]>();
  for (const level of new Set(candidates.map((c) => c.gradeLevel))) {
    if (!levels.some((l) => l.level === level)) fe[`classes-${level}`] = `Jahrgang ${level} gibt es nicht (Stammdaten)`;
    const names = normalizeClassNames(input.classes[level] ?? []);
    if (names.some((n) => n.length > 40 || !slugify(n))) fe[`classes-${level}`] = "Kurznamen wie „5a“ (höchstens 40 Zeichen)";
    classesByLevel.set(level, names);
  }
  const chosen = candidates.map((c) => ({ c, target: (input.assign[c.antragId] ?? "").trim() }));
  for (const { c, target } of chosen) {
    if (!target || target === SKIP) continue;
    if (!classesByLevel.get(c.gradeLevel)!.includes(target)) fe[`assign-${c.antragId}`] = `${c.childFirstName} ${c.childLastName}: Klasse „${target}“ steht nicht in der Liste für Jahrgang ${c.gradeLevel}`;
  }
  const admit = chosen.filter((x) => x.target && x.target !== SKIP);
  if (!admit.length) fe.assign = "Bitte mindestens ein Kind einer Klasse zuordnen – oder „Niemanden übernehmen“ ankreuzen";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  // nur Klassen, die auch Kinder bekommen
  const usedClasses = [...new Set(admit.map((x) => `${x.c.gradeLevel}|${x.target}`))].map((k) => {
    const [level, name] = k.split("|") as [string, string];
    return { level: Number(level), short: name, slug: slugify(name) };
  });

  // Benutzernamen eindeutig in DB und Lauf (wie planImport)
  const allNames = new Set((await db.select({ u: users.username }).from(users)).map((r) => r.u).filter((u): u is string => Boolean(u)));
  const takenMails = new Set((await db.select({ e: users.email }).from(users)).map((r) => r.e));
  const pick = (first: string, last: string) => {
    const base = toUsername(first, last) || "konto";
    let u = base;
    for (let n = 2; allNames.has(u); n++) u = `${base}${n}`;
    allNames.add(u);
    return u;
  };

  type NewUser = { id: string; username: string; password: string; hash: string; firstName: string; lastName: string; email: string; role: "schueler" | "eltern" };
  const students = new Map<string, NewUser & { klasse: { level: number; short: string } }>();
  type ExistingParent = { id: string; name: string; username: string | null; via: "konto" | "email" | "vorschlag" };
  const parentByMail = new Map<string, { existing: ExistingParent | null; created: NewUser | null; children: string[] }>();
  const linkSuggested = new Set(input.linkSuggested ?? []);
  const linkSuggested2 = new Set(input.linkSuggested2 ?? []);
  /** Elternteil einer Familie zuordnen: vorhandenes Konto bzw. dieselbe E-Mail-Adresse = ein Konto (Zwillinge, Geschwister) */
  const addParent = async (
    antragId: string,
    existing: ExistingParent | null,
    fullName: string,
    email: string,
    childLastName: string,
    /** S-01: eigener Schlüssel (Elternteil 2 ohne Haken) und Platzhalter statt der unbestätigten Adresse */
    unconfirmed?: { famKey: string },
  ): Promise<string> => {
    const famKey = existing ? `konto:${existing.id}` : (unconfirmed?.famKey ?? `mail:${email}`);
    const fam = parentByMail.get(famKey) ?? { existing, created: null, children: [] };
    if (!fam.children.includes(antragId)) fam.children.push(antragId);
    if (!fam.existing && !fam.created) {
      const { firstName, lastName } = splitParentName(fullName, childLastName);
      const pu = pick(firstName, lastName);
      const pw = generatePassword();
      // Adresse übernehmen, wenn sie noch kein Konto hat (sonst Platzhalter – z. B. Lehrkraft, die ihr Kind anmeldet)
      const mail = unconfirmed || takenMails.has(email) ? placeholderEmail(pu) : email;
      takenMails.add(mail);
      fam.created = { id: `u-${pu}`, username: pu, password: pw, hash: await hashPassword(pw), firstName, lastName, email: mail, role: "eltern" };
    }
    parentByMail.set(famKey, fam);
    return famKey;
  };
  for (const { c, target } of admit) {
    const username = pick(c.childFirstName, c.childLastName);
    const password = generatePassword();
    students.set(c.antragId, {
      id: `u-${username}`,
      username,
      password,
      hash: await hashPassword(password),
      firstName: c.childFirstName,
      lastName: c.childLastName,
      email: placeholderEmail(username),
      role: "schueler",
      klasse: { level: c.gradeLevel, short: target },
    });
    // Q5-20: angekreuzter Vorschlag (unbestätigte E-Mail) zählt wie ein vorhandenes Konto – ohne Haken nicht
    const parent = c.existingParent ?? (c.suggestedParent && linkSuggested.has(c.antragId) ? { ...c.suggestedParent, via: "vorschlag" as const } : null);
    const key1 = await addParent(c.antragId, parent, c.parent1Name, c.parent1Email, c.childLastName);
    // Q5-23 / GATE-031 (S-01): zweiter Elternteil – verknüpft bzw. zusammengeführt nur mit Haken; sonst eigenes Konto mit
    // Platzhalter-Adresse (Geschwister mit demselben Elternteil 1 teilen es sich)
    if (c.parent2) {
      const s = c.parent2.suggestion && linkSuggested2.has(c.antragId) ? c.parent2.suggestion : null;
      if (s?.kind === "konto") {
        if (`konto:${s.id}` !== key1) await addParent(c.antragId, { id: s.id, name: s.name, username: s.username, via: "vorschlag" }, c.parent2.name, c.parent2.email, c.childLastName);
      } else if (s?.kind === "antrag") {
        if (`mail:${c.parent2.email}` !== key1) await addParent(c.antragId, null, c.parent2.name, c.parent2.email, c.childLastName);
      } else {
        await addParent(c.antragId, null, c.parent2.name, c.parent2.email, c.childLastName, { famKey: `p2:${key1}:${c.parent2.email}` });
      }
    }
  }

  const classLabel = (short: string) => `Klasse ${short}`;
  const fromSuffix = slugify(from?.name ?? "alt");
  await db.transaction(async (tx) => {
    // Klassen: vorhandene des neuen Jahres wiederverwenden (gleicher Kurzname + Jahrgang), sonst anlegen; ein gleichnamiger
    // Kurzname des alten Jahres bekommt das Schuljahr angehängt (wie bei der Versetzung)
    const groupIdOf = new Map<string, string>();
    for (const k of usedClasses) {
      const [clash] = await tx.select({ id: groups.id, schoolYearId: groups.schoolYearId, gradeLevel: groups.gradeLevel, kind: groups.kind }).from(groups).where(eq(groups.slug, k.slug));
      if (clash?.schoolYearId === t.toYearId && clash.kind === "klasse" && clash.gradeLevel === k.level) {
        groupIdOf.set(`${k.level}|${k.short}`, clash.id);
        continue;
      }
      if (clash?.schoolYearId === t.fromYearId) await tx.update(groups).set({ slug: `${k.slug}-${fromSuffix}` }).where(eq(groups.id, clash.id));
      else if (clash) throw new ValidationError({ [`classes-${k.level}`]: `Kurzname „${k.slug}“ ist schon vergeben` });
      const [g] = await tx
        .insert(groups)
        .values({ name: classLabel(k.short), slug: k.slug, kind: "klasse", gradeLevel: k.level, schoolYearId: t.toYearId, ownerId: actorId })
        .returning({ id: groups.id });
      groupIdOf.set(`${k.level}|${k.short}`, g!.id);
    }
    const insertUser = async (u: NewUser) => {
      await tx.insert(users).values({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`,
        firstName: u.firstName,
        lastName: u.lastName,
        username: u.username,
        displayUsername: u.username,
        email: u.email,
        emailVerified: false,
        role: u.role,
        mustChangePassword: true,
      });
      await tx.insert(accounts).values({ id: `acc-${u.id}`, accountId: u.id, providerId: "credential", userId: u.id, password: u.hash });
    };
    for (const [antragId, s] of students) {
      await insertUser(s);
      await tx.insert(groupMembers).values({ groupId: groupIdOf.get(`${s.klasse.level}|${s.klasse.short}`)!, userId: s.id });
      await tx
        .update(anmeldungAntraege)
        .set({ status: "uebernommen", transferredUserId: s.id, transferredAt: now, updatedAt: now, retentionFrom: retentionFromFor("uebernommen", { now, completedAt: null, rejectKeepDays: 60, transferredAt: now }) })
        .where(and(eq(anmeldungAntraege.id, antragId), eq(anmeldungAntraege.status, "aufgenommen")));
      await tx.insert(anmeldungEreignisse).values({ antragId, actorId, kind: "status", text: `${ANTRAG_STATUS_LABELS.aufgenommen} → ${ANTRAG_STATUS_LABELS.uebernommen} (Schuljahreswechsel)`, at: now });
    }
    for (const fam of parentByMail.values()) {
      const parentId = fam.existing?.id ?? fam.created!.id;
      if (fam.created) await insertUser(fam.created);
      const kids = fam.children.map((a) => students.get(a)!.id);
      await tx
        .insert(parentChild)
        .values(kids.map((childId) => ({ parentId, childId })))
        .onConflictDoNothing();
    }
    // Q5-21: neu angelegte Konten merken (Kinder + neue Elternkonten, keine verknüpften) – für „Startpasswörter neu erzeugen“
    const created = [...[...students.values()].map((s) => s.id), ...[...parentByMail.values()].flatMap((f) => (f.created ? [f.created.id] : []))];
    await tx.update(schoolYearTransitions).set({ admittedAt: now, admittedUsers: created }).where(eq(schoolYearTransitions.id, t.id));
  });

  const credentials: AdmissionCredential[] = [];
  const nameOf = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`;
  for (const s of students.values()) credentials.push({ art: "Schüler:in", name: nameOf(s), klasse: s.klasse.short, username: s.username, password: s.password, kind: "" });
  for (const fam of parentByMail.values()) {
    const kids = fam.children.map((a) => students.get(a)!);
    const kidNames = kids.map(nameOf).sort((a, b) => a.localeCompare(b, "de")).join(", ");
    const klasse = [...new Set(kids.map((k) => k.klasse.short))].join(", ");
    if (fam.created) credentials.push({ art: "Elternteil", name: nameOf(fam.created), klasse, username: fam.created.username, password: fam.created.password, kind: kidNames });
    else if (fam.existing) credentials.push({ art: "Elternteil", name: fam.existing.name, klasse, username: fam.existing.username ?? "", password: "", kind: kidNames });
  }
  credentials.sort((a, b) => a.klasse.localeCompare(b.klasse, "de") || (a.art === b.art ? a.name.localeCompare(b.name, "de") : a.art === "Schüler:in" ? -1 : 1));
  const result: AdmissionResult = {
    classes: usedClasses.length,
    students: students.size,
    parentsCreated: [...parentByMail.values()].filter((f) => f.created).length,
    parentsLinked: [...parentByMail.values()].filter((f) => !f.created).length,
    parentsSuggestedLinked: [...parentByMail.values()].filter((f) => f.existing?.via === "vorschlag").length,
    skipped: candidates.length - admit.length,
    credentials,
  };
  await audit(db, actorId, "verwaltung.schuljahreswechsel.neuaufnahmen", null, {
    klassen: result.classes,
    schueler: result.students,
    eltern_neu: result.parentsCreated,
    eltern_verknuepft: result.parentsLinked,
    eltern_vorschlag: result.parentsSuggestedLinked,
    nicht_uebernommen: result.skipped,
  });
  return result;
}

export interface RegeneratedPasswords {
  credentials: AdmissionCredential[];
  /** Konten, die schon ein eigenes Passwort haben, gesperrt oder gelöscht sind – bleiben unverändert */
  skipped: number;
}

/**
 * Q5-21 (GATE-4c Code L6): Startpasswörter der gerade im Schritt „Neuaufnahmen“ angelegten Konten neu erzeugen – für den Fall,
 * dass die einmalige Anzeige verloren ging (Tab zu, Zeitlimit). Nur solange der Schuljahreswechsel läuft und nur für Konten,
 * die der Schritt selbst angelegt hat (verknüpfte, schon vorhandene Elternkonten nie) und die noch kein eigenes Passwort gesetzt
 * haben (`must_change_password`), aktiv sind. Alte Sitzungen enden; ein Audit-Eintrag ohne Namen.
 */
export async function regenerateAdmissionPasswords(
  db: Db,
  actorId: string,
  transitionId: string,
  now = new Date(),
  /** nur Tests: zwischen Hashen und Schreiben (C-04) */
  hooks: { afterHash?: () => Promise<void> } = {},
): Promise<RegeneratedPasswords> {
  const [t] = await db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, transitionId));
  if (!t || t.completedAt) throw new ValidationError({ transition: "Schuljahreswechsel nicht gefunden oder abgeschlossen" });
  if (!t.admittedAt) throw new ValidationError({ transition: "Die Neuaufnahmen sind noch nicht übernommen" });
  const ids = t.admittedUsers ?? [];
  if (!ids.length) throw new ValidationError({ transition: "Der Schritt „Neuaufnahmen“ hat keine Konten angelegt" });
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, name: users.name, username: users.username, role: users.role, status: users.status, mustChangePassword: users.mustChangePassword, leftOn: users.leftOn })
    .from(users)
    .where(inArray(users.id, ids));
  const open = rows.filter((u) => u.status === "active" && u.mustChangePassword && !u.leftOn && (u.role === "schueler" || u.role === "eltern"));
  if (!open.length) throw new ValidationError({ transition: "Alle angelegten Konten haben schon ein eigenes Passwort – einzelne Konten über die Benutzerverwaltung zurücksetzen" });
  // Klasse der Kinder im neuen Schuljahr, Kinder der neuen Elternkonten (nur aus diesem Schritt)
  const studentIds = rows.filter((u) => u.role === "schueler").map((u) => u.id);
  const klassen = studentIds.length
    ? await db
        .select({ userId: groupMembers.userId, slug: groups.slug })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, studentIds), eq(groups.schoolYearId, t.toYearId), eq(groups.kind, "klasse")))
    : [];
  const klasseOf = new Map(klassen.map((k) => [k.userId, k.slug]));
  const links = studentIds.length ? await db.select().from(parentChild).where(inArray(parentChild.childId, studentIds)) : [];
  const fullName = (u: (typeof rows)[number]) => [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name;
  const byId = new Map(rows.map((u) => [u.id, u]));

  const fresh: { u: (typeof rows)[number]; password: string; hash: string }[] = [];
  for (const u of open) {
    const password = generatePassword();
    fresh.push({ u, password, hash: await hashPassword(password) });
  }
  // GATE-031 (C-04): das Hashen dauert bei einem Jahrgang leicht 10–30 s – wer in der Zeit sein eigenes Passwort gesetzt hat,
  // bleibt unberührt (in der Transaktion erneut geprüft und gesperrt)
  await hooks.afterHash?.();
  let applied: typeof fresh = [];
  await db.transaction(async (tx) => {
    const still = new Set(
      (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, fresh.map((f) => f.u.id)), eq(users.mustChangePassword, true), eq(users.status, "active"), isNull(users.leftOn)))
          .for("update")
      ).map((r) => r.id),
    );
    applied = fresh.filter((f) => still.has(f.u.id));
    for (const { u, hash } of applied) {
      const updated = await tx
        .update(accounts)
        .set({ password: hash })
        .where(and(eq(accounts.userId, u.id), eq(accounts.providerId, "credential")))
        .returning({ id: accounts.id });
      if (!updated.length) await tx.insert(accounts).values({ id: `acc-${u.id}`, accountId: u.id, providerId: "credential", userId: u.id, password: hash });
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
    }
  });
  for (const { u } of applied) endLiveStreams(u.id);

  const credentials: AdmissionCredential[] = applied.map(({ u, password }) => {
    if (u.role === "schueler") return { art: "Schüler:in", name: fullName(u), klasse: klasseOf.get(u.id) ?? "", username: u.username ?? "", password, kind: "" };
    const kids = links.filter((l) => l.parentId === u.id).map((l) => byId.get(l.childId)!);
    return {
      art: "Elternteil",
      name: fullName(u),
      klasse: [...new Set(kids.map((k) => klasseOf.get(k.id) ?? ""))].filter(Boolean).join(", "),
      username: u.username ?? "",
      password,
      kind: kids
        .map(fullName)
        .sort((a, b) => a.localeCompare(b, "de"))
        .join(", "),
    };
  });
  credentials.sort((a, b) => a.klasse.localeCompare(b.klasse, "de") || (a.art === b.art ? a.name.localeCompare(b.name, "de") : a.art === "Schüler:in" ? -1 : 1));
  const skipped = ids.length - applied.length;
  await audit(db, actorId, "verwaltung.schuljahreswechsel.startpasswoerter", t.id, { anzahl: credentials.length, uebersprungen: skipped, zeit: now.toISOString() });
  return { credentials, skipped };
}

/** Zugangsdaten der Neuaufnahmen als CSV (Semikolon, BOM) – vorhandene Elternkonten ohne Passwort („Zugang besteht“). */
export function admissionCredentialsCsv(list: readonly AdmissionCredential[]): string {
  return toCsv([
    ["Art", "Name", "Klasse", "Benutzername", "Startpasswort", "Kind"],
    ...list.map((c) => [c.art, c.name, c.klasse, c.username, c.password || "Zugang besteht", c.kind]),
  ]);
}

/** Für die Schritt-Anzeige: Gruppen, die es im neuen Schuljahr schon gibt (Klassen eines Jahrgangs). */
export async function existingClasses(db: Db, toYearId: string, levels: readonly number[]): Promise<{ level: number; slug: string }[]> {
  if (!levels.length) return [];
  return db
    .select({ level: groups.gradeLevel, slug: groups.slug })
    .from(groups)
    .where(and(eq(groups.schoolYearId, toYearId), eq(groups.kind, "klasse"), inArray(groups.gradeLevel, [...levels])))
    .then((r) => r.map((x) => ({ level: x.level!, slug: x.slug })));
}
