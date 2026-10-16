// Schulanmeldung für Familien mit Konto (P4-34b, Q-32 Weg 1): eingeloggte Eltern (z. B. mit Geschwisterkind an der Schule)
// melden im geschützten Bereich an. Identität und Konto sind geprüft – keine Mailbestätigung, kein Vorgangslink; der Antrag
// hängt am Elternkonto (`parent_user_id`) und ist nur dort sichtbar.
import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";
import { audit } from "@/core/audit";
import { realEmail } from "@/core/auth/email";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungVerfahren, groupMembers, groups, parentChild, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { parentInformedSql } from "@/core/school/majority";
import { enqueueMail, appUrl } from "@/core/mail";
import { mailFooter } from "@/core/mail-templates";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { consumeRate, rateLimitMessage } from "@/core/rate-limit";
import { ValidationError } from "@/modules/verwaltung/users";
import type { AntragStatus } from "./labels";
import { MAX_ACTIVE_PER_EMAIL, publicVerfahren, validateAntragForm, vorgangView, type SubmitResult, type VorgangView } from "./public";
import { gongNewAntrag } from "./sekretariat";
import { insertAntrag } from "./service";

/** Nur Elternkonten melden so an. */
export function canApplyWithAccount(viewer: Pick<PermissionSet, "role">): boolean {
  return viewer.role === "eltern";
}

function assertParent(viewer: PermissionSet) {
  if (!canApplyWithAccount(viewer)) throw new ForbiddenError("anmeldung (nur Elternkonten)");
}

/** Vorbelegung aus dem Konto: Name, echte E-Mail-Adresse, Geschwisterkinder (Name + Klasse). */
export async function accountPrefill(db: Db, viewer: PermissionSet): Promise<Record<string, string>> {
  assertParent(viewer);
  const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, viewer.userId));
  const kids = await db
    .select({ id: users.id, name: users.name })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    // Q5-05: eigenständige Geschwister nur mit deren Einwilligung
    .where(and(eq(parentChild.parentId, viewer.userId), eq(users.status, "active"), parentInformedSql()))
    .orderBy(de(users.firstName));
  const classes = kids.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(eq(groups.kind, "klasse"), inArray(groupMembers.userId, kids.map((k) => k.id))))
    : [];
  const classOf = new Map(classes.map((c) => [c.userId, c.name]));
  const siblings = kids.map((k) => (classOf.get(k.id) ? `${k.name}, ${classOf.get(k.id)}` : k.name)).join(" / ");
  return {
    parent1Name: u?.name ?? "",
    parent1Email: realEmail(u?.email) ?? "",
    ...(siblings ? { sibling: "on", siblingNote: siblings.slice(0, 120) } : {}),
  };
}

/**
 * Antrag aus dem geschützten Bereich: gleiche Prüfung wie öffentlich, aber ohne Honeypot/Zeitstempel und Mailbestätigung –
 * gleich „eingegangen“ bzw. „Termin vereinbart“. Höchstens 5 je Tag und 4 offene je Konto und Verfahren.
 */
export async function submitAccountAntrag(
  db: Db,
  viewer: PermissionSet,
  verfahrenId: string,
  raw: Record<string, string | undefined>,
  ctx: { now: Date; school: string },
): Promise<SubmitResult & { antragId?: string }> {
  assertParent(viewer);
  const v = await publicVerfahren(db, verfahrenId, ctx.now);
  if (!v) return { ok: false, error: "Diese Anmeldung ist zurzeit nicht geöffnet." };
  let data;
  try {
    data = validateAntragForm(raw, v, new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(ctx.now));
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  const [active] = await db
    .select({ n: count() })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, v.id), eq(anmeldungAntraege.parentUserId, viewer.userId), notInArray(anmeldungAntraege.status, ["zurueckgezogen", "abgelehnt"])));
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_EMAIL) return { ok: false, error: `Für dieses Verfahren sind schon ${MAX_ACTIVE_PER_EMAIL} Anmeldungen offen.` };
  const rate = await consumeRate(db, "anmeldung.konto", viewer.userId, ctx.now);
  if (!rate.allowed) return { ok: false, error: rateLimitMessage(rate.retryAt) };
  let created: { id: string; number: string };
  try {
    created = await insertAntrag(db, v.id, data, { now: ctx.now, status: "eingegangen", future: true, parentUserId: viewer.userId });
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  await enqueueMail(
    db,
    {
      to: data.parent1Email,
      subject: `${ctx.school}: Anmeldung eingegangen (${created.number})`,
      text: [
        "Guten Tag,",
        "",
        `vielen Dank – Ihre Anmeldung für „${v.name}“ ist bei uns eingegangen (Vorgangsnummer ${created.number}).`,
        `Stand und Termin sehen Sie in SchulOS unter ${appUrl("/schulanmeldung")}.`,
        "Verbindlich wird die Anmeldung erst im persönlichen Gespräch.",
        mailFooter(ctx.school),
      ].join("\n"),
      purpose: "anmeldung-eingegangen",
    },
    ctx.now,
  );
  await audit(db, viewer.userId, "anmeldung.eingegangen", created.id, { verfahren: v.id, konto: true });
  await gongNewAntrag(db, v.id);
  return { ok: true, antragId: created.id };
}

export interface MyAntrag {
  id: string;
  number: string;
  verfahren: string;
  status: AntragStatus;
  childFirstName: string;
  createdAt: Date;
}

/** Eigene Anträge (über das Konto gestellt), neueste zuerst. */
export async function myAntraege(db: Db, viewer: PermissionSet): Promise<MyAntrag[]> {
  if (!canApplyWithAccount(viewer)) return [];
  const rows = await db
    .select({ a: anmeldungAntraege, verfahren: anmeldungVerfahren.name })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .where(eq(anmeldungAntraege.parentUserId, viewer.userId))
    .orderBy(desc(anmeldungAntraege.createdAt), asc(anmeldungAntraege.id));
  return rows.map((r) => ({
    id: r.a.id,
    number: `A-${r.a.year}-${String(r.a.seq).padStart(4, "0")}`,
    verfahren: r.verfahren,
    status: r.a.status,
    childFirstName: r.a.childFirstName,
    createdAt: r.a.createdAt,
  }));
}

/** Eigener Antrag – fremde IDs liefern null (keine Auskunft, ob es den Antrag gibt). */
export async function myAntrag(db: Db, viewer: PermissionSet, antragId: string): Promise<VorgangView | null> {
  if (!canApplyWithAccount(viewer) || typeof antragId !== "string" || antragId.length > 64) return null;
  const [a] = await db
    .select()
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.id, antragId), eq(anmeldungAntraege.parentUserId, viewer.userId)));
  return a ? vorgangView(db, a) : null;
}
