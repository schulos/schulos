// Elternkonten in der Benutzerverwaltung (P4-38): Elternteil zu einem Kind neu anlegen (Startpasswort wie beim Import,
// E-Mail als Kontaktadresse – unbestätigt, bis die Person sie bestätigt, Q5-04) oder ein vorhandenes Elternkonto verknüpfen
// (`parent_child`), Verknüpfung lösen. Vorher gab es Elternkonten nur aus dem Seed; anlegen ließen sie sich als Benutzer mit
// Rolle „Eltern“, verknüpfen aber nicht. Grundlage für die Übernahme aus der Schulanmeldung (P4-39).
// Eine Verknüpfung öffnet den Eltern die Daten des Kindes (Stundenplan, Abwesenheiten, Elternbriefe …) – daher Audit.
import { and, eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { parentChild, users } from "@/core/db/schema";
import { assertMayManage, loadActor } from "./escalation";
import { createUser, ValidationError } from "./users";

/** Ein Kind hat höchstens so viele verknüpfte Elternkonten (Sorgeberechtigte + Puffer für Patchwork-Familien). */
export const MAX_PARENTS = 4;

async function loadRoles(db: Db, parentId: string, childId: string) {
  const [parent] = await db.select({ role: users.role, name: users.name }).from(users).where(eq(users.id, parentId));
  const [child] = await db.select({ role: users.role }).from(users).where(eq(users.id, childId));
  return { parent, child };
}

/**
 * Elternkonto mit Kind verknüpfen. Nur Rolle Eltern ↔ Rolle Schüler:in; das Kind muss die handelnde Person verwalten dürfen
 * (SEC-04). Bereits verknüpft → nichts zu tun.
 */
export async function linkParent(db: Db, actorId: string, parentId: string, childId: string): Promise<boolean> {
  const { parent, child } = await loadRoles(db, parentId, childId);
  if (!child || child.role !== "schueler") throw new ValidationError({ parent: "Eltern lassen sich nur mit Schüler:innen verknüpfen" });
  if (!parent) throw new ValidationError({ parent: "Elternkonto gibt es nicht" });
  if (parent.role !== "eltern") throw new ValidationError({ parent: `${parent.name} hat nicht die Rolle Eltern` });
  await assertMayManage(db, await loadActor(db, actorId), childId);
  const existing = await db.select({ p: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, childId));
  if (existing.some((e) => e.p === parentId)) return false;
  if (existing.length >= MAX_PARENTS) throw new ValidationError({ parent: `Höchstens ${MAX_PARENTS} Elternkonten je Kind` });
  await db.insert(parentChild).values({ parentId, childId }).onConflictDoNothing();
  await audit(db, actorId, "verwaltung.eltern.verknuepft", childId, { eltern: parentId });
  return true;
}

/** Verknüpfung lösen – das Elternkonto bleibt (ohne Kind räumt es später der Konto-Lebenszyklus auf). */
export async function unlinkParent(db: Db, actorId: string, parentId: string, childId: string): Promise<void> {
  await assertMayManage(db, await loadActor(db, actorId), childId);
  const removed = await db
    .delete(parentChild)
    .where(and(eq(parentChild.parentId, parentId), eq(parentChild.childId, childId)))
    .returning({ p: parentChild.parentId });
  if (removed.length) await audit(db, actorId, "verwaltung.eltern.geloest", childId, { eltern: parentId });
}

/** Vorhandenes Elternkonto per Benutzername verknüpfen (Formular in der Benutzerverwaltung). */
export async function linkParentByUsername(db: Db, actorId: string, childId: string, username: string): Promise<boolean> {
  const name = username.trim().toLowerCase();
  if (!name) throw new ValidationError({ username: "Benutzername des Elternkontos angeben" });
  const [p] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.username, name));
  if (!p || p.role !== "eltern") throw new ValidationError({ username: "Kein Elternkonto mit diesem Benutzernamen" });
  return linkParent(db, actorId, p.id, childId);
}

export interface NewParentInput {
  firstName: string;
  lastName: string;
  email?: string | null;
}

/**
 * Neues Elternkonto anlegen und mit dem Kind verknüpfen. Benutzername wie beim Import (`vorname.nachname`, ggf. mit Zahl),
 * Startpasswort einmalig zurück (muss bei der ersten Anmeldung geändert werden). E-Mail optional, gilt als unbestätigt.
 */
export async function createParentForChild(
  db: Db,
  actorId: string,
  childId: string,
  input: NewParentInput,
): Promise<{ id: string; username: string; password: string }> {
  const [child] = await db.select({ role: users.role }).from(users).where(eq(users.id, childId));
  if (!child || child.role !== "schueler") throw new ValidationError({ firstName: "Eltern lassen sich nur zu Schüler:innen anlegen" });
  await assertMayManage(db, await loadActor(db, actorId), childId);
  const existing = await db.select({ p: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, childId));
  if (existing.length >= MAX_PARENTS) throw new ValidationError({ firstName: `Höchstens ${MAX_PARENTS} Elternkonten je Kind` });
  const created = await createUser(db, actorId, { firstName: input.firstName, lastName: input.lastName, role: "eltern", email: input.email ?? null });
  await db.insert(parentChild).values({ parentId: created.id, childId });
  await audit(db, actorId, "verwaltung.eltern.verknuepft", childId, { eltern: created.id, neu: true });
  return created;
}
