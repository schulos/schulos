// Klassenwünsche (KB-03, docs/KLASSENBILDUNG.md Stufe 2): interne „zusammen“-/„nicht zusammen“-Wünsche zwischen zwei Anträgen
// desselben Verfahrens, vom Sekretariat aus Aufnahmegespräch oder Grundschulbogen erfasst (kb-1/kb-2) – höchstens 2 je Kind,
// ohne Begründung. Dazu das Häkchen „getrennt“ je Familie (gleiche E-Mail von Elternteil 1, z. B. Mehrlinge; kb-4): Vorgabe
// zusammen. Beides fließt als weiches Ziel in den Vorschlag im Schritt „Neuaufnahmen“ (`klassenbildung.ts`).
//
// Datenschutz: Wünsche sind Daten über ein anderes Kind. Sichtbar nur mit `anmeldung.view` (Sekretariat/Schulleitung), erfassen
// nur mit `anmeldung.manage`; nicht im Verlauf (der steht in der Auskunft), nur im Audit-Log ohne Namen. Löschklasse folgt dem
// Antrag (LK-90, Cascade auf beide Anträge). Auskunft: eigene Wünsche ohne Partnerkind (`auskunft.ts`).
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungKlassenwuensche } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import type { KbWish } from "./klassenbildung";
import { MAX_WISHES_PER_CHILD } from "./klassenbildung";
import { KLASSENWUNSCH_ARTEN, type AntragStatus, type KlassenwunschArt } from "./labels";
import { antragNumber, canManage, canView } from "./service";

/** Anträge, die Wünsche haben bzw. als Partner gewählt werden können: gültige Anmeldungen, die noch zur Klassenbildung gehen */
export const WISH_STATUSES = ["eingegangen", "termin", "vollstaendig", "aufgenommen", "warteliste"] as const satisfies readonly AntragStatus[];

const wishable = (s: AntragStatus) => (WISH_STATUSES as readonly string[]).includes(s);

/** Familie = gleiche E-Mail von Elternteil 1 (ohne Groß/Klein, ohne Leerzeichen) – wie bei der Übernahme */
const familyKey = (email: string) => email.trim().toLowerCase();

export interface WishRow {
  id: string;
  art: KlassenwunschArt;
  partner: { id: string; number: string; name: string };
}

export interface KlassenwunschView {
  /** Wünsche dieses Antrags */
  own: WishRow[];
  /** Wünsche anderer Anträge, die dieses Kind nennen (nur zur Information) */
  incoming: WishRow[];
  /** mögliche Partner (gleiches Verfahren, gültige Anmeldung, ohne eigenen Antrag und ohne schon gewählte) */
  candidates: { id: string; number: string; name: string }[];
  /** andere Kinder derselben Familie im Verfahren (Mehrlinge/Geschwister) – nur dann gibt es das Häkchen „getrennt“ */
  family: { id: string; number: string; name: string }[];
  familySeparate: boolean;
  /** darf erfassen (Recht + Antrag im passenden Stand) */
  editable: boolean;
}

function assertView(v: PermissionSet) {
  if (!canView(v)) throw new ForbiddenError("anmeldung.view");
}
function assertManage(v: PermissionSet) {
  if (!canManage(v)) throw new ForbiddenError("anmeldung.manage");
}

const childName = (a: { childFirstName: string; childLastName: string }) => `${a.childLastName}, ${a.childFirstName}`;

/** Wünsche, Partnerauswahl und Familie eines Antrags für die Antragsansicht im Sekretariat. null = Antrag gibt es nicht. */
export async function klassenwunschView(db: Db, viewer: PermissionSet, antragId: string): Promise<KlassenwunschView | null> {
  assertView(viewer);
  const [a] = await db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, antragId));
  if (!a) return null;
  const others = await db
    .select({
      id: anmeldungAntraege.id,
      year: anmeldungAntraege.year,
      seq: anmeldungAntraege.seq,
      childFirstName: anmeldungAntraege.childFirstName,
      childLastName: anmeldungAntraege.childLastName,
      parent1Email: anmeldungAntraege.parent1Email,
      status: anmeldungAntraege.status,
    })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, a.verfahrenId), sql`${anmeldungAntraege.id} <> ${a.id}`))
    .orderBy(de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName));
  const byId = new Map(others.map((o) => [o.id, o]));
  const ref = (id: string) => {
    const o = byId.get(id);
    return o ? { id, number: antragNumber(o.year, o.seq), name: childName(o) } : null;
  };
  const wishes = await db
    .select()
    .from(anmeldungKlassenwuensche)
    .where(or(eq(anmeldungKlassenwuensche.antragId, a.id), eq(anmeldungKlassenwuensche.partnerAntragId, a.id)))
    .orderBy(anmeldungKlassenwuensche.createdAt, anmeldungKlassenwuensche.id);
  const own: WishRow[] = [];
  const incoming: WishRow[] = [];
  for (const w of wishes) {
    if (w.antragId === a.id) {
      const p = ref(w.partnerAntragId);
      if (p) own.push({ id: w.id, art: w.art, partner: p });
    } else {
      const p = ref(w.antragId);
      if (p) incoming.push({ id: w.id, art: w.art, partner: p });
    }
  }
  const chosen = new Set(own.map((w) => w.partner.id));
  const fam = familyKey(a.parent1Email);
  return {
    own,
    incoming,
    candidates: others.filter((o) => wishable(o.status) && !chosen.has(o.id)).map((o) => ref(o.id)!),
    family: others.filter((o) => familyKey(o.parent1Email) === fam && o.status !== "unbestaetigt").map((o) => ref(o.id)!),
    familySeparate: a.familySeparate,
    editable: canManage(viewer) && wishable(a.status),
  };
}

async function loadEditable(db: Db, antragId: string, field: string) {
  const [a] = await db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, antragId));
  if (!a) throw new ValidationError({ [field]: "Antrag gibt es nicht" });
  if (!wishable(a.status)) throw new ValidationError({ [field]: "In diesem Stand lassen sich keine Klassenwünsche mehr erfassen" });
  return a;
}

/** Wunsch erfassen (Sekretariat): Partner aus demselben Verfahren, höchstens 2 je Kind, je Paar nur eine Art. */
export async function addKlassenwunsch(
  db: Db,
  viewer: PermissionSet,
  antragId: string,
  input: { partnerId: string; art: string },
  now = new Date(),
): Promise<void> {
  assertManage(viewer);
  const a = await loadEditable(db, antragId, "partnerId");
  if (!(KLASSENWUNSCH_ARTEN as readonly string[]).includes(input.art)) throw new ValidationError({ art: "Art des Wunsches wählen" });
  if (!input.partnerId) throw new ValidationError({ partnerId: "Kind wählen" });
  if (input.partnerId === a.id) throw new ValidationError({ partnerId: "Ein Kind kann sich nicht selbst wünschen" });
  const [p] = await db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, input.partnerId));
  if (!p || p.verfahrenId !== a.verfahrenId || !wishable(p.status)) throw new ValidationError({ partnerId: "Kind aus diesem Verfahren wählen" });
  const existing = await db.select().from(anmeldungKlassenwuensche).where(eq(anmeldungKlassenwuensche.antragId, a.id));
  if (existing.some((w) => w.partnerAntragId === p.id)) throw new ValidationError({ partnerId: "Für dieses Kind gibt es schon einen Wunsch" });
  if (existing.length >= MAX_WISHES_PER_CHILD) throw new ValidationError({ partnerId: `Höchstens ${MAX_WISHES_PER_CHILD} Wünsche je Kind` });
  await db.insert(anmeldungKlassenwuensche).values({ antragId: a.id, partnerAntragId: p.id, art: input.art as KlassenwunschArt, createdBy: viewer.userId, createdAt: now });
  // Audit ohne Namen und ohne Partner (Daten über ein anderes Kind) – nur Antrag und Art
  await audit(db, viewer.userId, "anmeldung.antrag.wunsch", a.id, { art: input.art });
}

/** Wunsch entfernen (Sekretariat). */
export async function removeKlassenwunsch(db: Db, viewer: PermissionSet, antragId: string, wishId: string): Promise<void> {
  assertManage(viewer);
  await loadEditable(db, antragId, "wish");
  const gone = await db
    .delete(anmeldungKlassenwuensche)
    .where(and(eq(anmeldungKlassenwuensche.id, wishId), eq(anmeldungKlassenwuensche.antragId, antragId)))
    .returning({ id: anmeldungKlassenwuensche.id });
  if (!gone.length) throw new ValidationError({ wish: "Wunsch gibt es nicht mehr" });
  await audit(db, viewer.userId, "anmeldung.antrag.wunsch.entfernt", antragId);
}

/**
 * Häkchen „getrennt“ (kb-4): gilt für die ganze Familie im Verfahren (alle Anträge mit derselben E-Mail von Elternteil 1).
 * Gibt die Zahl der geänderten Anträge zurück.
 */
export async function setFamilySeparate(db: Db, viewer: PermissionSet, antragId: string, separate: boolean): Promise<number> {
  assertManage(viewer);
  const a = await loadEditable(db, antragId, "separate");
  const changed = await db
    .update(anmeldungAntraege)
    .set({ familySeparate: separate })
    .where(
      and(
        eq(anmeldungAntraege.verfahrenId, a.verfahrenId),
        sql`lower(trim(${anmeldungAntraege.parent1Email})) = ${familyKey(a.parent1Email)}`,
        sql`${anmeldungAntraege.familySeparate} <> ${separate}`,
      ),
    )
    .returning({ id: anmeldungAntraege.id });
  if (changed.length) await audit(db, viewer.userId, "anmeldung.antrag.getrennt", a.id, { getrennt: separate, antraege: changed.length });
  return changed.length;
}

/**
 * Für den Schritt „Neuaufnahmen“: Wünsche zwischen den übergebenen Anträgen (beide Seiten müssen dabei sein) in der Form, die
 * `proposeClasses` erwartet – nur Antrags-IDs und Art, keine Namen.
 */
export async function wishesForAdmission(db: Db, antragIds: readonly string[]): Promise<KbWish[]> {
  if (!antragIds.length) return [];
  const ids = new Set(antragIds);
  const rows = await db
    .select({ from: anmeldungKlassenwuensche.antragId, to: anmeldungKlassenwuensche.partnerAntragId, kind: anmeldungKlassenwuensche.art })
    .from(anmeldungKlassenwuensche)
    .where(inArray(anmeldungKlassenwuensche.antragId, [...ids]))
    .orderBy(anmeldungKlassenwuensche.createdAt, anmeldungKlassenwuensche.id);
  return rows.filter((r) => ids.has(r.to));
}
