// Benutzerverwaltung – reine Service-Funktionen (DB rein, Daten raus), voll getestet.
import { hashPassword } from "better-auth/crypto";
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import {
  accounts,
  groupMembers,
  groups,
  parentChild,
  sessions,
  users,
  ROLES,
  type Role,
} from "@/core/db/schema";
import { toUsername } from "@/core/seed/rng";
import { generatePassword } from "@schulos/server/passwort";
import { de } from "@/core/db/sort";
import { endLiveStreams } from "@/core/notifications/bus";
import { EmailChangeError, emailTaken, isPlaceholderEmail, normalizeEmail, placeholderEmail, sendEmailConfirmationFor } from "@/core/auth/email";
import { assertMayAssignRole, assertMayManage, loadActor } from "./escalation";

export const PAGE_SIZE = 50;

export interface UserListFilter {
  q?: string;
  role?: Role;
  groupId?: string;
  status?: "active" | "locked";
  page?: number;
}

export interface UserListRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  username: string | null;
  shortCode: string | null;
  role: Role;
  status: "active" | "locked";
  leftOn: string | null;
  classes: string[];
  /** Q5-24: echte Adresse eingetragen? (Platzhalter = nein) und von der Person bestätigt */
  hasEmail: boolean;
  emailVerified: boolean;
}

/** Benutzerliste mit Suche (Name, Benutzername, Kürzel), Filtern und Klassen je Person. */
export async function listUsers(db: Db, f: UserListFilter = {}): Promise<{ rows: UserListRow[]; total: number }> {
  const where: SQL[] = [];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(users.name, like), ilike(users.username, like), ilike(users.shortCode, like))!);
  }
  if (f.role) where.push(eq(users.role, f.role));
  if (f.status) where.push(eq(users.status, f.status));
  if (f.groupId) {
    where.push(
      inArray(users.id, db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, f.groupId))),
    );
  }
  const cond = where.length ? and(...where) : undefined;
  const page = Math.max(1, f.page ?? 1);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        shortCode: users.shortCode,
        role: users.role,
        status: users.status,
        leftOn: users.leftOn,
        email: users.email,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(cond)
      .orderBy(de(users.lastName), de(users.firstName), asc(users.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(users).where(cond),
  ]);

  const ids = rows.map((r) => r.id);
  const classRows = ids.length
    ? await db
        .select({ userId: groupMembers.userId, slug: groups.slug })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, ids), eq(groups.kind, "klasse")))
        .orderBy(asc(groups.slug))
    : [];
  return {
    // die Adresse selbst bleibt in der Liste weg – nur ob es eine gibt und ob sie bestätigt ist
    rows: rows.map(({ email, ...r }) => ({ ...r, hasEmail: !isPlaceholderEmail(email), classes: classRows.filter((c) => c.userId === r.id).map((c) => c.slug) })),
    total: totalRow?.n ?? 0,
  };
}

export async function getUserDetail(db: Db, id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) return null;
  const [memberships, parents, children] = await Promise.all([
    db
      .select({ id: groups.id, name: groups.name, slug: groups.slug, kind: groups.kind, role: groupMembers.role })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, id))
      .orderBy(asc(groups.kind), de(groups.name)),
    db
      .select({ id: users.id, name: users.name })
      .from(parentChild)
      .innerJoin(users, eq(users.id, parentChild.parentId))
      .where(eq(parentChild.childId, id)),
    db
      .select({ id: users.id, name: users.name })
      .from(parentChild)
      .innerJoin(users, eq(users.id, parentChild.childId))
      .where(eq(parentChild.parentId, id)),
  ]);
  return { user, memberships, parents, children };
}

// ------------------------------------------------------------------ Schreiben

export class ValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("Eingaben ungültig");
    this.name = "ValidationError";
  }
}

export interface UserInput {
  firstName: string;
  lastName: string;
  role: Role;
  shortCode?: string | null;
  username?: string | null;
  /** echte E-Mail-Adresse (Q5-04); leer = keine (Platzhalter). `undefined` = unverändert lassen */
  email?: string | null;
  /** Sprechzeiten und Raum – nur Rolle `beratung` (Q5-17), sonst verworfen */
  officeHours?: string | null;
}

export const MAX_OFFICE_HOURS = 300;

function normalizeInput(input: UserInput) {
  const errors: Record<string, string> = {};
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const shortCode = input.shortCode?.trim().toUpperCase() || null;
  if (!firstName) errors.firstName = "Vorname fehlt";
  if (!lastName) errors.lastName = "Nachname fehlt";
  if (!ROLES.includes(input.role)) errors.role = "Unbekannte Rolle";
  if (shortCode && !/^[A-ZÄÖÜ]{2,4}$/.test(shortCode)) errors.shortCode = "Kürzel: 2–4 Buchstaben";
  if (shortCode && input.role !== "lehrkraft") errors.shortCode = "Kürzel nur für Lehrkräfte";
  const username = input.username?.trim().toLowerCase() || null;
  if (username && !/^[a-z0-9._]{3,30}$/.test(username)) errors.username = "3–30 Zeichen: a–z, 0–9, Punkt, Unterstrich";
  const mail = input.email === undefined ? null : normalizeEmail(input.email);
  if (mail?.error) errors.email = mail.error;
  const officeHours = input.role === "beratung" ? input.officeHours?.trim() || null : null;
  if (officeHours && officeHours.length > MAX_OFFICE_HOURS) errors.officeHours = `Höchstens ${MAX_OFFICE_HOURS} Zeichen`;
  return { errors, firstName, lastName, shortCode, username, email: mail?.email ?? null, officeHours };
}

async function assertUnique(db: Db, field: "username" | "shortCode", value: string, exceptId?: string) {
  const col = field === "username" ? users.username : users.shortCode;
  const [hit] = await db.select({ id: users.id }).from(users).where(eq(col, value));
  if (hit && hit.id !== exceptId) {
    throw new ValidationError({ [field]: field === "username" ? "Benutzername ist vergeben" : "Kürzel ist vergeben" });
  }
}

/** Freien Benutzernamen aus Vor-/Nachname ableiten (vorname.nachname, ggf. mit Zahl). */
export async function suggestUsername(db: Db, firstName: string, lastName: string): Promise<string> {
  const base = toUsername(firstName, lastName) || "benutzer";
  const taken = new Set(
    (await db.select({ u: users.username }).from(users).where(ilike(users.username, `${base}%`))).map((r) => r.u),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

export async function createUser(db: Db, actorId: string, input: UserInput): Promise<{ id: string; username: string; password: string }> {
  const n = normalizeInput(input);
  if (Object.keys(n.errors).length) throw new ValidationError(n.errors);
  // SEC-04: Admin-Konten nur durch Admins, keine Verwaltungsrechte vergeben, die man selbst nicht hat
  await assertMayAssignRole(db, await loadActor(db, actorId), input.role);
  const username = n.username ?? (await suggestUsername(db, n.firstName, n.lastName));
  await assertUnique(db, "username", username);
  if (n.shortCode) await assertUnique(db, "shortCode", n.shortCode);
  if (n.email && (await emailTaken(db, n.email))) throw new ValidationError({ email: "Diese Adresse hat schon ein anderes Konto" });

  const id = `u-${username}`;
  const password = generatePassword();
  await db.insert(users).values({
    id,
    name: `${n.firstName} ${n.lastName}`,
    firstName: n.firstName,
    lastName: n.lastName,
    username,
    displayUsername: username,
    // echte Adresse aus der Verwaltung gilt erst nach Bestätigung durch die Person als bestätigt (Q5-04)
    email: n.email ?? placeholderEmail(username),
    emailVerified: false,
    role: input.role,
    shortCode: n.shortCode,
    officeHours: n.officeHours,
    mustChangePassword: true,
  });
  await db.insert(accounts).values({
    id: `acc-${id}`,
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(password),
  });
  await audit(db, actorId, "verwaltung.user.create", id, { role: input.role, email: Boolean(n.email) });
  return { id, username, password };
}

export async function updateUser(db: Db, actorId: string, id: string, input: UserInput): Promise<void> {
  const n = normalizeInput(input);
  if (Object.keys(n.errors).length) throw new ValidationError(n.errors);
  if (n.shortCode) await assertUnique(db, "shortCode", n.shortCode, id);
  const [current] = await db.select({ role: users.role, email: users.email, username: users.username }).from(users).where(eq(users.id, id));
  if (!current) throw new ValidationError({ firstName: "Konto gibt es nicht" });
  // SEC-04: die eigene Rolle ändert nur jemand anderes (auch Admins entziehen sich die Admin-Rolle nicht selbst)
  if (current.role !== input.role && id === actorId) {
    throw new ValidationError({
      role: current.role === "admin" ? "Du kannst dir die Admin-Rolle nicht selbst entziehen" : "Deine eigene Rolle kann nur jemand anderes ändern",
    });
  }
  const actor = await loadActor(db, actorId);
  if (id !== actorId) await assertMayManage(db, actor, id, "role");
  if (current.role !== input.role) await assertMayAssignRole(db, actor, input.role);
  // E-Mail (Q5-04): nur bei Änderung anfassen – eine geänderte Adresse ist wieder unbestätigt
  let emailChange: { email: string; emailVerified: false } | null = null;
  if (input.email !== undefined) {
    const next = n.email ?? placeholderEmail(current.username ?? id);
    if (next !== current.email) {
      if (n.email && (await emailTaken(db, n.email, id))) throw new ValidationError({ email: "Diese Adresse hat schon ein anderes Konto" });
      emailChange = { email: next, emailVerified: false };
    }
  }
  await db
    .update(users)
    .set({ firstName: n.firstName, lastName: n.lastName, name: `${n.firstName} ${n.lastName}`, role: input.role, shortCode: n.shortCode, officeHours: n.officeHours, ...(emailChange ?? {}) })
    .where(eq(users.id, id));
  await audit(db, actorId, "verwaltung.user.update", id, { role: input.role, ...(emailChange ? { email: isPlaceholderEmail(emailChange.email) ? "entfernt" : "geaendert" } : {}) });
}

export async function setUserLocked(db: Db, actorId: string, id: string, locked: boolean): Promise<void> {
  if (id === actorId && locked) throw new ValidationError({ status: "Du kannst dich nicht selbst sperren" });
  await assertMayManage(db, await loadActor(db, actorId), id, "status");
  await db.update(users).set({ status: locked ? "locked" : "active" }).where(eq(users.id, id));
  // Gesperrte Benutzer fliegen sofort raus – auch aus offenen Live-Strömen.
  if (locked) {
    await db.delete(sessions).where(eq(sessions.userId, id));
    endLiveStreams(id);
  }
  await audit(db, actorId, locked ? "verwaltung.user.lock" : "verwaltung.user.unlock", id);
}

/** Setzt ein neues Zufallspasswort und meldet alle Sitzungen ab. Gibt das Klartext-Passwort EINMAL zurück. */
export async function resetPassword(db: Db, actorId: string | null, id: string): Promise<string> {
  // SEC-04: sonst ließe sich ein Konto mit mehr Rechten (Admin, Schulleitung) per Reset übernehmen; null = Kommandozeile
  await assertMayManage(db, await loadActor(db, actorId), id, "password");
  const password = generatePassword();
  const hash = await hashPassword(password);
  const updated = await db
    .update(accounts)
    .set({ password: hash })
    .where(and(eq(accounts.userId, id), eq(accounts.providerId, "credential")))
    .returning({ id: accounts.id });
  if (updated.length === 0) {
    await db.insert(accounts).values({ id: `acc-${id}`, accountId: id, providerId: "credential", userId: id, password: hash });
  }
  await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, id));
  await db.delete(sessions).where(eq(sessions.userId, id));
  endLiveStreams(id);
  await audit(db, actorId, "verwaltung.user.password_reset", id);
  return password;
}

/**
 * Q5-25: Die Schulsozialarbeit (Rolle `beratung`) pflegt Sprechzeiten und Raum selbst (Profil „Sprechzeiten und Raum“).
 * Nur die eigene Zeile – die ID kommt aus der Sitzung, nie aus dem Formular; andere Rollen dürfen das Feld nicht setzen.
 * Die Verwaltung ändert es weiterhin im Benutzerformular. Leer = keine Sprechzeiten.
 */
export async function updateOwnOfficeHours(db: Db, userId: string, raw: string | null): Promise<string | null> {
  const [me] = await db.select({ role: users.role, officeHours: users.officeHours }).from(users).where(eq(users.id, userId));
  if (me?.role !== "beratung") throw new ValidationError({ officeHours: "Sprechzeiten pflegt nur die Schulsozialarbeit (Rolle Beratung)" });
  const officeHours = raw?.replace(/\s+/g, " ").trim() || null;
  if (officeHours && officeHours.length > MAX_OFFICE_HOURS) throw new ValidationError({ officeHours: `Höchstens ${MAX_OFFICE_HOURS} Zeichen` });
  if (officeHours === me.officeHours) return officeHours;
  await db.update(users).set({ officeHours }).where(and(eq(users.id, userId), eq(users.role, "beratung")));
  await audit(db, userId, "konto.sprechzeiten", userId, { leer: !officeHours });
  return officeHours;
}

/**
 * Q5-24: Bestätigungslink an die eingetragene, unbestätigte Adresse senden (Knopf in der Benutzerverwaltung). Gleiche
 * Grenzen wie die übrige Kontoverwaltung (SEC-04); Audit ohne Adresse.
 */
export async function sendEmailConfirmation(db: Db, actorId: string, id: string, opts: { school: string; now?: Date; mailOn?: boolean }): Promise<string> {
  await assertMayManage(db, await loadActor(db, actorId), id, "email");
  try {
    const r = await sendEmailConfirmationFor(db, id, opts);
    await audit(db, actorId, "verwaltung.user.email_link", id);
    return r.sentTo;
  } catch (err) {
    if (err instanceof EmailChangeError) throw new ValidationError({ email: err.message });
    throw err;
  }
}

export async function countByRole(db: Db): Promise<Record<Role, number>> {
  const rows = await db.select({ role: users.role, n: sql<number>`count(*)::int` }).from(users).groupBy(users.role);
  const out = { schueler: 0, lehrkraft: 0, eltern: 0, personal: 0, beratung: 0, verwaltung: 0, admin: 0 } satisfies Record<Role, number>;
  for (const r of rows) out[r.role] = r.n;
  return out;
}
