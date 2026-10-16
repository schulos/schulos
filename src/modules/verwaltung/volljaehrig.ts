// Q5-05 (I-05): Kennzeichen „eigenständig (volljährig)“ am Konto. Die Verwaltung setzt es (kein Geburtsdatum nötig); ab dann
// handelt die Person selbst und ihre Eltern sehen nichts mehr (src/core/school/majority.ts). „Eltern weiter informieren“ setzt
// nur die Person selbst (Einwilligung, jederzeit widerrufbar) – die Verwaltung kann sie nicht setzen, nur mit dem Kennzeichen
// zusammen zurücknehmen.
import { eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { assertMayManage, loadActor } from "./escalation";
import { ValidationError } from "./users";

/** Verwaltung: Kennzeichen setzen bzw. entfernen. Entfernen nimmt auch die Einwilligung „Eltern weiter informieren“ zurück. */
export async function setSelfResponsible(db: Db, actorId: string, userId: string, on: boolean): Promise<void> {
  const [u] = await db.select({ role: users.role, selfResponsible: users.selfResponsible }).from(users).where(eq(users.id, userId));
  if (!u) throw new ValidationError({ selfResponsible: "Konto gibt es nicht" });
  if (u.role !== "schueler") throw new ValidationError({ selfResponsible: "Nur Schüler:innen können eigenständig sein" });
  await assertMayManage(db, await loadActor(db, actorId), userId, "selfResponsible");
  if (u.selfResponsible === on) return;
  await db.update(users).set({ selfResponsible: on, parentsInformedSince: null }).where(eq(users.id, userId));
  await audit(db, actorId, on ? "verwaltung.user.eigenstaendig" : "verwaltung.user.eigenstaendig_aus", userId);
  if (on) {
    await notify(db, [userId], {
      moduleId: "verwaltung",
      title: "Du handelst jetzt eigenständig",
      body: "Elternbriefe und Eltern-Umfragen gehen an dich, Abwesenheiten meldest du selbst. Deine Eltern sehen deine Daten nicht mehr – außer du willigst ein.",
      href: "/konto/eltern",
    });
  }
}

/** Die eigenständige Person selbst: Eltern weiter informieren (Einwilligung) ja/nein. */
export async function setParentsInformed(db: Db, userId: string, on: boolean, now = new Date()): Promise<void> {
  const [u] = await db.select({ selfResponsible: users.selfResponsible, since: users.parentsInformedSince }).from(users).where(eq(users.id, userId));
  if (!u?.selfResponsible) throw new ValidationError({ parentsInformed: "Nur eigenständige Schüler:innen können das festlegen" });
  if (Boolean(u.since) === on) return;
  await db.update(users).set({ parentsInformedSince: on ? now : null }).where(eq(users.id, userId));
  await audit(db, userId, on ? "konto.eltern_informieren.ein" : "konto.eltern_informieren.aus", userId);
}

/** Stand für die Seite „Eltern informieren“. */
export async function parentsInformedState(db: Db, userId: string): Promise<{ selfResponsible: boolean; since: Date | null }> {
  const [u] = await db.select({ selfResponsible: users.selfResponsible, since: users.parentsInformedSince }).from(users).where(eq(users.id, userId));
  return { selfResponsible: Boolean(u?.selfResponsible), since: u?.since ?? null };
}
