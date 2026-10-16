// Auskunft zu Anträgen der Schulanmeldung (P4-42, Art. 15 DSGVO). Anträge ohne Konto hängen an keinem Benutzer – die
// allgemeine Auskunft (Verwaltung → Datenschutz, je Konto) findet sie nicht. Das Sekretariat sucht deshalb per
// Vorgangsnummer oder E-Mail-Adresse und gibt einen Antrag als JSON heraus. Die Identität der anfragenden Person prüft die
// Schule (Antwort an die hinterlegte Adresse bzw. persönlich) – siehe DSB-FRAGEN.md §3e.
//
// Inhalt wie die allgemeine Auskunft (S19): alle Angaben zum Antrag, Termin, Unterlagen-Häkchen, Entscheidung, Verlauf –
// bei Handlungen der Schule nur Zeitpunkt und Art, keine Namen von Beschäftigten; keine Hashes der geheimen Links, keine IDs
// anderer Konten. Jede Suche und jede Auskunft steht im Audit-Log (ohne Personendaten).
//
// GATE-031 (S-02): Die Adresse des zweiten Elternteils hat die antragstellende Person eingetragen, sie ist nie bestätigt.
// Ein Treffer über diese Adresse ist gekennzeichnet und bekommt nur eine eingeschränkte Auskunft (eigene Angaben von
// Elternteil 2, Vorgangsnummer, Verfahren, Stand) – keine Angaben zu Elternteil 1 (Daten Dritter, Art. 15 Abs. 4), keine
// Anschrift, keine Hinweise, keine Notizen.
// GATE-031 R-05: Den Umfang leitet der Server aus dem Suchbegriff ab (`query`): Treffer über die Adresse von Elternteil 2 ist
// immer eingeschränkt, egal was das Formular schickt; ein Suchbegriff, der nicht zum Antrag passt, liefert nichts. Bei der
// Vorgangsnummer wählt die Schule ausdrücklich (zwei Knöpfe). Jede Auskunft hält Umfang und Anlass im Audit-Log fest.
import { asc, eq, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren, rooms } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import type { StateCode } from "@/core/school/catalog";
import { anmeldungKatalog } from "./katalog";
import { ANTRAG_STATUS_LABELS, VERFAHREN_KIND_LABELS, type AntragStatus } from "./labels";
import { antragNumber, canManage, LK90_DAYS } from "./service";

/** Auskunft geben darf, wer Anträge bearbeitet (Sekretariat) oder die Datenschutz-Aufgaben hat */
export const canAuskunft = (v: PermissionSet) => canManage(v) || hasPermission(v, "verwaltung.privacy");

function assertAuskunft(v: PermissionSet) {
  if (!canAuskunft(v)) throw new ForbiddenError("anmeldung.manage");
}

const NUMBER = /^A-(\d{4})-(\d{1,6})$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuskunftTreffer {
  id: string;
  number: string;
  verfahrenName: string;
  status: AntragStatus;
  childName: string;
  createdAt: Date;
  /** worüber gefunden – „elternteil2“: nur eingeschränkte Auskunft (S-02) */
  via: "vorgangsnummer" | "elternteil1" | "elternteil2";
  /** Antrag nennt einen zweiten Elternteil (dann gibt es bei der Vorgangsnummer auch die eingeschränkte Fassung) */
  hasParent2: boolean;
}

/** Umfang einer Auskunft: alles (Elternteil 1 bzw. Vorgangsnummer) oder nur die Angaben zum zweiten Elternteil */
export type AuskunftUmfang = "voll" | "elternteil2";

/** Anlass einer Auskunft: Suchtreffer (Art) bzw. „antrag“ (aus der Antragsansicht, ohne Suche) */
export type AuskunftAnlass = AuskunftTreffer["via"] | "antrag";

/**
 * GATE-031 R-05: Umfang einer Auskunft serverseitig festlegen. `query` = Suchbegriff, über den der Antrag gefunden wurde:
 * Adresse von Elternteil 1 → voll, Adresse von Elternteil 2 → **immer** eingeschränkt (`requested` zählt nicht),
 * Vorgangsnummer bzw. ohne Suchbegriff (Antragsansicht) → wie gewählt (Vorgabe voll). Passt der Suchbegriff nicht zum Antrag → null.
 */
export function resolveAuskunftUmfang(
  a: { year: number; seq: number; parent1Email: string; parent2Email: string | null },
  query: string | undefined,
  requested: AuskunftUmfang | undefined,
): { umfang: AuskunftUmfang; anlass: AuskunftAnlass } | null {
  const q = query?.trim().slice(0, 200) ?? "";
  if (!q) return { umfang: requested ?? "voll", anlass: "antrag" };
  const num = NUMBER.exec(q);
  if (num) return Number(num[1]) === a.year && Number(num[2]) === a.seq ? { umfang: requested ?? "voll", anlass: "vorgangsnummer" } : null;
  const mail = q.toLowerCase();
  if (a.parent1Email.toLowerCase() === mail) return { umfang: "voll", anlass: "elternteil1" };
  if (a.parent2Email?.toLowerCase() === mail) return { umfang: "elternteil2", anlass: "elternteil2" };
  return null;
}

/**
 * Anträge zu einer Vorgangsnummer („A-2027-0042“) oder E-Mail-Adresse (genau, ohne Groß/Klein; Elternteil 1 oder 2, Q5-23). Andere
 * Eingaben → leere Liste (keine Teilsuche über alle Familien). Auch unbestätigte und entschiedene Anträge, alle Verfahren.
 */
export async function findAntraegeForAuskunft(db: Db, viewer: PermissionSet, query: string): Promise<AuskunftTreffer[]> {
  assertAuskunft(viewer);
  const q = query.trim().slice(0, 200);
  const num = NUMBER.exec(q);
  const where = num
    ? sql`${anmeldungAntraege.year} = ${Number(num[1])} and ${anmeldungAntraege.seq} = ${Number(num[2])}`
    : EMAIL.test(q)
      ? sql`(lower(${anmeldungAntraege.parent1Email}) = ${q.toLowerCase()} or lower(${anmeldungAntraege.parent2Email}) = ${q.toLowerCase()})`
      : null;
  if (!where) return [];
  const rows = await db
    .select({ a: anmeldungAntraege, verfahrenName: anmeldungVerfahren.name })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .where(where)
    .orderBy(asc(anmeldungAntraege.year), asc(anmeldungAntraege.seq));
  await audit(db, viewer.userId, "anmeldung.auskunft.suche", null, { art: num ? "vorgangsnummer" : "email", treffer: rows.length });
  return rows.map(({ a, verfahrenName }) => ({
    id: a.id,
    number: antragNumber(a.year, a.seq),
    verfahrenName,
    status: a.status,
    childName: `${a.childFirstName} ${a.childLastName}`,
    createdAt: a.createdAt,
    via: num ? "vorgangsnummer" : a.parent1Email.toLowerCase() === q.toLowerCase() ? "elternteil1" : "elternteil2",
    hasParent2: !!a.parent2Email,
  }));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const addDaysMs = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Ein Antrag als Auskunft (JSON-Objekt). null = gibt es nicht. */
export async function antragAuskunft(
  db: Db,
  viewer: PermissionSet,
  antragId: string,
  ctx: { now?: Date; state?: StateCode; school?: string; umfang?: AuskunftUmfang; query?: string } = {},
): Promise<{ filename: string; data: Record<string, unknown> } | null> {
  assertAuskunft(viewer);
  const now = ctx.now ?? new Date();
  const [r] = await db
    .select({ a: anmeldungAntraege, v: anmeldungVerfahren })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .where(eq(anmeldungAntraege.id, antragId));
  if (!r) return null;
  const { a, v } = r;
  const resolved = resolveAuskunftUmfang(a, ctx.query, ctx.umfang);
  if (!resolved) return null;
  const { umfang, anlass } = resolved;
  const [slot] = a.slotId
    ? await db
        .select({ startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name, note: anmeldungSlots.note })
        .from(anmeldungSlots)
        .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
        .where(eq(anmeldungSlots.id, a.slotId))
    : [];
  const events = await db
    .select({ at: anmeldungEreignisse.at, kind: anmeldungEreignisse.kind, text: anmeldungEreignisse.text, actorId: anmeldungEreignisse.actorId })
    .from(anmeldungEreignisse)
    .where(eq(anmeldungEreignisse.antragId, antragId))
    .orderBy(asc(anmeldungEreignisse.at), asc(anmeldungEreignisse.id));
  const number = antragNumber(a.year, a.seq);
  const loeschung = a.retentionFrom
    ? `Wird am ${addDaysMs(a.retentionFrom, LK90_DAYS).toISOString().slice(0, 10)} gelöscht (Löschlauf der Schule).`
    : "Offener bzw. aufgenommener Antrag – die Löschfrist beginnt mit Rücknahme, Verfahrensabschluss oder Übernahme.";
  if (umfang === "elternteil2") {
    if (!a.parent2Email) return null;
    const data = {
      auskunft: {
        art: "Auskunft nach Art. 15 DSGVO – Schulanmeldung (zweiter Elternteil)",
        erstellt: now.toISOString(),
        schule: ctx.school ?? null,
        hinweis:
          "Eingeschränkte Auskunft: Ihre Angaben als zweiter Elternteil in einem Antrag zur Schulanmeldung. Diese Angaben hat die antragstellende Person gemacht. Angaben zur antragstellenden Person und zum Kind gibt die Schule nur an diese heraus.",
      },
      verfahren: { name: v.name, art: VERFAHREN_KIND_LABELS[v.kind] },
      antrag: {
        vorgangsnummer: number,
        stand: ANTRAG_STATUS_LABELS[a.status],
        eingegangen: iso(a.createdAt),
        elternteil2: { name: a.parent2Name, email: a.parent2Email },
        loeschung,
      },
    };
    await audit(db, viewer.userId, "anmeldung.auskunft", antragId, { verfahren: v.id, umfang, anlass });
    return { filename: `auskunft-${number}-elternteil2.json`, data };
  }
  const checklist = (a.checklist ?? {}) as Record<string, boolean>;
  const katalog = anmeldungKatalog(ctx.state ?? "NW");
  const data = {
    auskunft: {
      art: "Auskunft nach Art. 15 DSGVO – Schulanmeldung",
      erstellt: now.toISOString(),
      schule: ctx.school ?? null,
      hinweis:
        "Enthält alle in SchulOS gespeicherten Angaben zu diesem Antrag. Handlungen der Schule stehen nur mit Zeitpunkt und Art (ohne Namen von Beschäftigten). Unterlagen werden nicht hochgeladen, nur als „vorgelegt“ vermerkt.",
    },
    verfahren: {
      name: v.name,
      art: VERFAHREN_KIND_LABELS[v.kind],
      anmeldungAb: iso(v.opensAt),
      anmeldungBis: iso(v.closesAt),
      abgeschlossen: iso(v.completedAt),
    },
    antrag: {
      vorgangsnummer: number,
      stand: ANTRAG_STATUS_LABELS[a.status],
      eingegangen: iso(a.createdAt),
      emailBestaetigt: iso(a.confirmedAt),
      ueberElternkonto: a.parentUserId !== null,
      einwilligungDatenschutzhinweis: iso(a.consentAt),
      kind: {
        vorname: a.childFirstName,
        nachname: a.childLastName,
        geburtsdatum: a.childBirthDate,
        grundschule: a.primarySchool,
        geschwisterkind: a.sibling,
        geschwisterHinweis: a.siblingNote,
      },
      eltern: {
        name: a.parent1Name,
        email: a.parent1Email,
        telefon: a.parent1Phone,
        anschrift: { strasse: a.addressStreet, plz: a.addressZip, ort: a.addressCity },
        elternteil2: a.parent2Name,
        elternteil2Email: a.parent2Email,
      },
      zweitwunsch: a.secondChoiceSchool,
      hinweiseFuerDasGespraech: a.hints,
      termin: slot ? { beginn: iso(slot.startsAt), ende: iso(slot.endsAt), ort: slot.room ?? slot.note ?? null } : null,
      unterlagenVorgelegt: katalog.checklist.map((c) => ({ unterlage: c.label, vorgelegt: checklist[c.key] === true })),
      entscheidung: a.decidedAt ? { zeitpunkt: iso(a.decidedAt), notizDerSchule: a.decisionNote } : null,
      uebernommenAm: iso(a.transferredAt),
      loeschung,
    },
    verlauf: events.map((e) => ({ zeitpunkt: e.at.toISOString(), art: e.kind, text: e.text, durch: e.actorId ? (e.actorId === a.parentUserId ? "Eltern (Konto)" : "Schule") : "Eltern bzw. System" })),
  };
  await audit(db, viewer.userId, "anmeldung.auskunft", antragId, { verfahren: v.id, umfang, anlass });
  return { filename: `auskunft-${number}.json`, data };
}
