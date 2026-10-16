// Öffentliche Schulanmeldung (P4-34): Formular ohne Konto mit Double-Opt-In. Reine Logik + DB, ohne Next – die Server
// Actions (public-actions.ts) liefern IP und Zeit über `publicAction()`.
//
// Missbrauchsschutz (docs/PHASE4.md §3.3): Honeypot, signierter Zeitstempel (≥ 5 s), strikte Prüfung mit Längengrenzen,
// Rate-Limits je IP und je E-Mail, höchstens 4 offene Anträge je E-Mail und Verfahren. Antworten verraten nicht, ob es eine
// Adresse oder einen Vorgang gibt: Honeypot, E-Mail-Limit und „zu viele Anträge“ antworten wie ein Erfolg.
import { and, count, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren, rooms, schoolYears } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { checkStamp, hashPublicToken, isTokenShape, newPublicToken, sameHash, signStamp } from "@/core/public-token";
import { consumeRate, emailSubject, ipv6Prefix48, rateLimitMessage, resetRate } from "@/core/rate-limit";
import type { StateCode } from "@/core/school/catalog";
import { TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { isMailAddress } from "@schulos/server/mail";
import { anmeldungKatalog } from "./katalog";
import { parseFields, type AntragStatus, type VerfahrenFields, type VerfahrenKind } from "./labels";
import { anmeldungConfirmMail, anmeldungLimitMail, anmeldungReceivedMail, anmeldungSlotMail, anmeldungWithdrawnMail, slotText } from "./mails";
import { acceptsSubmissions, ACCESS_GRACE_DAYS, accessExpiryFor, assertSlotFree, freeSlots, insertAntrag, OPEN_STATUSES, setAntragSlot, setAntragStatus, type AntragData, type SlotRow } from "./service";
import type { PermissionSet } from "@/core/permissions";
import { gongNewAntrag } from "./sekretariat";

/** Bestätigungslink gilt so lange; danach löscht der Job den Antrag vollständig (P4-35). */
export const CONFIRM_HOURS = 48;
/** offene Anträge je E-Mail-Adresse und Verfahren */
export const MAX_ACTIVE_PER_EMAIL = 4;
/** Mindestdauer zwischen Ausliefern und Absenden des Formulars */
export const FORM_MIN_MS = 5_000;
/** Formular gilt so lange nach dem Laden */
export const FORM_MAX_MS = 12 * 3_600_000;
/** Höchstlänge eines Rohwerts, bevor überhaupt geprüft wird */
export const RAW_MAX = 1_000;
export const HINTS_MAX = 300;

/** Status, die als „offen“ für das Limit je E-Mail zählen (alles außer zurückgezogen/abgelehnt) */
const INACTIVE: AntragStatus[] = ["zurueckgezogen", "abgelehnt"];

export const stampPurpose = (verfahrenId: string) => `anmeldung:${verfahrenId}`;
export const formStamp = (verfahrenId: string, now = new Date()) => signStamp(stampPurpose(verfahrenId), now);

// ---------------------------------------------------------------- Verfahren (öffentlich)

export interface PublicVerfahren {
  id: string;
  name: string;
  kind: VerfahrenKind;
  intro: string;
  opensAt: Date;
  closesAt: Date;
  targetGradeLevel: number;
  /** Beginn des Zielschuljahres (YYYY-MM-DD) – für die Altersprüfung */
  schoolYearStartsOn: string;
  fields: VerfahrenFields;
}

/** Verfahren, das gerade Anträge annimmt – sonst null (Entwurf, geschlossen, außerhalb des Zeitraums, unbekannt). */
export async function publicVerfahren(db: Db, id: string, now = new Date()): Promise<PublicVerfahren | null> {
  if (typeof id !== "string" || id.length > 64) return null;
  const [r] = await db
    .select({ v: anmeldungVerfahren, startsOn: schoolYears.startsOn })
    .from(anmeldungVerfahren)
    .innerJoin(schoolYears, eq(schoolYears.id, anmeldungVerfahren.targetSchoolYearId))
    .where(eq(anmeldungVerfahren.id, id));
  if (!r || !acceptsSubmissions(r.v, now)) return null;
  return {
    id: r.v.id,
    name: r.v.name,
    kind: r.v.kind,
    intro: r.v.intro,
    opensAt: r.v.opensAt,
    closesAt: r.v.closesAt,
    targetGradeLevel: r.v.targetGradeLevel,
    schoolYearStartsOn: r.startsOn,
    fields: parseFields(r.v.fields, r.v.kind),
  };
}

/** Freie künftige Termine (ohne Namen, nur Zeit, Plätze und Raum) – für die Slot-Wahl live. */
export async function publicSlots(db: Db, verfahrenId: string, now = new Date()): Promise<(SlotRow & { roomName: string | null })[]> {
  const slots = await freeSlots(db, verfahrenId, now);
  const roomIds = [...new Set(slots.flatMap((s) => (s.roomId ? [s.roomId] : [])))];
  const names = roomIds.length ? await db.select({ id: rooms.id, name: rooms.name }).from(rooms) : [];
  const byId = new Map(names.map((r) => [r.id, r.name]));
  return slots.map((s) => ({ ...s, roomName: s.roomId ? (byId.get(s.roomId) ?? null) : null }));
}

/**
 * Slot-Wahl live (öffentliche Action, GATE-4c / Security N3): nur für Verfahren, die gerade Anträge annehmen, und je IP
 * begrenzt – sonst lieferte eine bekannte Verfahrens-ID auch Termine von Entwürfen/geschlossenen Verfahren, ungebremst.
 */
export async function liveSlots(db: Db, verfahrenId: string, ctx: { ip: string; now: Date }): Promise<(SlotRow & { roomName: string | null })[]> {
  if (!(await consumeRate(db, "anmeldung.termine", ctx.ip, ctx.now)).allowed) return [];
  const v = await publicVerfahren(db, verfahrenId, ctx.now);
  return v ? publicSlots(db, v.id, ctx.now) : [];
}

// ---------------------------------------------------------------- Eingaben prüfen

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/;
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const TEXT = /^[\p{L}\p{M}\p{N} .,'’"„“()/&+:-]+$/u;
const PHONE = /^[0-9+()/ .-]{5,30}$/;
const ZIP = /^[0-9A-Za-z -]{3,10}$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Links im Freitext (Spam): Schema, www., oder Domain mit gängiger Endung */
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+\.(?:de|com|net|org|info|biz|ru|cn|io|xyz|top|eu|at|ch|me|ly|link|click)\b)/i;

/** Alter am Stichtag (volle Jahre). */
export function ageOn(birth: string, day: string): number | null {
  const b = YMD.exec(birth);
  const d = YMD.exec(day);
  if (!b || !d) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const check = new Date(Date.UTC(by, bm - 1, bd));
  if (check.getUTCFullYear() !== by || check.getUTCMonth() !== bm - 1 || check.getUTCDate() !== bd) return null;
  const [dy, dm, dd] = [Number(d[1]), Number(d[2]), Number(d[3])];
  return dy - by - (dm < bm || (dm === bm && dd < bd) ? 1 : 0);
}

/** Plausibles Alter für den Zieljahrgang: Jahrgang + 4 bis Jahrgang + 8 (Klasse 5: 9–13 Jahre). */
export function ageRange(gradeLevel: number): [number, number] {
  return [gradeLevel + 4, gradeLevel + 8];
}

/** Rein: Formularfelder prüfen und in Antragsdaten übersetzen. Fehler als Feldfehler (deutsch). */
export function validateAntragForm(raw: Record<string, string | undefined>, v: Pick<PublicVerfahren, "kind" | "fields" | "targetGradeLevel" | "schoolYearStartsOn">, today: string): AntragData {
  const fe: Record<string, string> = {};
  const get = (k: string) => {
    const x = raw[k];
    if (typeof x !== "string") return "";
    if (x.length > RAW_MAX) {
      fe[k] = "Eingabe zu lang";
      return "";
    }
    // GATE-4c (Code-L7): NFC – zerlegte Umlaute („u“ + Trema) würden im cp1252-Export der Schulverwaltung zu „u?“
    return x.normalize("NFC").replace(/\r\n/g, "\n").trim();
  };
  const plain = (k: string, label: string, opts: { required?: boolean; max: number; pattern?: RegExp; patternMsg?: string }): string | null => {
    const s = get(k).replace(/\s+/g, " ");
    if (fe[k]) return null;
    if (!s) {
      if (opts.required) fe[k] = `${label} angeben`;
      return null;
    }
    if (CONTROL.test(s)) fe[k] = "Unzulässige Zeichen";
    else if (s.length > opts.max) fe[k] = `Bitte kürzer (höchstens ${opts.max} Zeichen)`;
    else if (opts.pattern && !opts.pattern.test(s)) fe[k] = opts.patternMsg ?? "Unzulässige Zeichen";
    return s;
  };
  const nameMsg = "Nur Buchstaben, Leerzeichen, Bindestrich und Apostroph";
  const childFirstName = plain("childFirstName", "Vorname", { required: true, max: 60, pattern: NAME, patternMsg: nameMsg });
  const childLastName = plain("childLastName", "Nachname", { required: true, max: 60, pattern: NAME, patternMsg: nameMsg });
  const birth = get("childBirthDate");
  if (!fe.childBirthDate) {
    const age = birth ? ageOn(birth, v.schoolYearStartsOn) : null;
    const [min, max] = ageRange(v.targetGradeLevel);
    if (!birth) fe.childBirthDate = "Geburtsdatum angeben";
    else if (age === null || birth >= today) fe.childBirthDate = "Gültiges Geburtsdatum angeben";
    else if (age < min || age > max) fe.childBirthDate = `Zum Schuljahresbeginn ist das Kind ${age} Jahre alt – erwartet ${min} bis ${max}. Bitte prüfen oder beim Sekretariat melden.`;
  }
  const primarySchool = plain("primarySchool", v.kind === "klasse5" ? "Grundschule" : "Bisherige Schule", { required: true, max: 120, pattern: TEXT });
  const sibling = v.fields.geschwister && raw.sibling === "on";
  const siblingNote = v.fields.geschwister && sibling ? plain("siblingNote", "Name und Klasse", { max: 120, pattern: TEXT }) : null;
  const secondChoiceSchool = v.fields.zweitwunsch ? plain("secondChoiceSchool", "Zweitwunsch", { max: 120, pattern: TEXT }) : null;
  const parent1Name = plain("parent1Name", "Name", { required: true, max: 120, pattern: NAME, patternMsg: nameMsg });
  const emailRaw = get("parent1Email").toLowerCase();
  if (!fe.parent1Email) {
    if (!emailRaw) fe.parent1Email = "E-Mail-Adresse angeben";
    else if (CONTROL.test(emailRaw) || !isMailAddress(emailRaw)) fe.parent1Email = "Gültige E-Mail-Adresse angeben";
  }
  const parent1Phone = plain("parent1Phone", "Telefon", { max: 30, pattern: PHONE, patternMsg: "Nur Ziffern, Leerzeichen und + ( ) / -" });
  const addressStreet = plain("addressStreet", "Straße und Hausnummer", { required: true, max: 120, pattern: TEXT });
  const addressZip = plain("addressZip", "Postleitzahl", { required: true, max: 10, pattern: ZIP, patternMsg: "Postleitzahl prüfen" });
  const addressCity = plain("addressCity", "Ort", { required: true, max: 80, pattern: TEXT });
  const parent2Name = v.fields.elternteil2 ? plain("parent2Name", "Name", { max: 120, pattern: NAME, patternMsg: nameMsg }) : null;
  // Q5-23: E-Mail von Elternteil 2 – optional, nur mit Namen und Bestätigung, dass Elternteil 2 Bescheid weiß (Art. 14);
  // keine Mail an diese Adresse während des Verfahrens, sie dient nur dem Elternkonto bei der Übernahme
  let parent2Email: string | null = null;
  if (v.fields.elternteil2) {
    const e2 = get("parent2Email").toLowerCase();
    if (e2 && !fe.parent2Email) {
      if (CONTROL.test(e2) || !isMailAddress(e2)) fe.parent2Email = "Gültige E-Mail-Adresse angeben";
      else if (e2 === emailRaw) fe.parent2Email = "Bitte eine andere Adresse als bei Elternteil 1 angeben – oder das Feld leer lassen";
      else {
        if (!parent2Name && !fe.parent2Name) fe.parent2Name = "Name des zweiten Elternteils angeben (gehört zur E-Mail-Adresse)";
        if (raw.parent2Consent !== "on") fe.parent2Consent = "Bitte bestätigen Sie, dass der zweite Elternteil von der Angabe weiß";
        parent2Email = e2;
      }
    }
  }
  let hints: string | null = null;
  if (v.fields.hinweise) {
    const h = get("hints");
    if (h && !fe.hints) {
      if (CONTROL.test(h.replace(/\n/g, " "))) fe.hints = "Unzulässige Zeichen";
      else if (h.length > HINTS_MAX) fe.hints = `Bitte kürzer (höchstens ${HINTS_MAX} Zeichen)`;
      else if (LINK.test(h)) fe.hints = "Bitte keine Links oder Internetadressen";
      else hints = h;
    }
  }
  const slotId = get("slotId");
  if (!slotId && !fe.slotId) fe.slotId = "Bitte einen Gesprächstermin wählen";
  else if (slotId.length > 64) fe.slotId = "Termin gibt es nicht";
  if (raw.consent !== "on") fe.consent = "Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    childFirstName: childFirstName!,
    childLastName: childLastName!,
    childBirthDate: birth,
    primarySchool,
    sibling,
    siblingNote,
    secondChoiceSchool,
    parent1Name: parent1Name!,
    parent1Email: emailRaw,
    parent1Phone,
    addressStreet,
    addressZip,
    addressCity,
    parent2Name,
    parent2Email,
    hints,
    slotId,
  };
}

// ---------------------------------------------------------------- Einreichen

export interface SubmitContext {
  /** gekürztes IP-Subjekt (publicAction) */
  ip: string;
  now: Date;
  school: string;
  state: StateCode;
}

export type SubmitResult = { ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Die eine Antwort für alle Fälle, in denen nichts über Adressen verraten werden darf. */
export const SUBMIT_OK: SubmitResult = { ok: true };

const ymdBerlin = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

/**
 * Antrag aus dem öffentlichen Formular. Ergebnis `{ ok: true }` heißt für die Eltern immer „bitte E-Mail bestätigen“ –
 * auch bei Honeypot, zu schnellem Absenden, E-Mail-Limit oder zu vielen offenen Anträgen (dann ohne Antrag; im letzten
 * Fall mit einer Hinweis-Mail nur an diese Adresse).
 */
export async function submitAntrag(db: Db, verfahrenId: string, raw: Record<string, string | undefined>, ctx: SubmitContext): Promise<SubmitResult> {
  const v = await publicVerfahren(db, verfahrenId, ctx.now);
  if (!v) return { ok: false, error: "Diese Anmeldung ist zurzeit nicht geöffnet." };
  // Bots: Honeypot ausgefüllt bzw. sofort abgeschickt → tun, als hätte es geklappt (zählt trotzdem gegen die IP)
  const stamp = checkStamp(raw.stamp, stampPurpose(v.id), ctx.now, { minMs: FORM_MIN_MS, maxMs: FORM_MAX_MS });
  if ((raw.website ?? "") !== "" || stamp === "zu-frueh") {
    await consumeRate(db, "anmeldung.ip", ctx.ip, ctx.now);
    return SUBMIT_OK;
  }
  if (stamp !== "ok") return { ok: false, error: "Das Formular ist abgelaufen. Bitte laden Sie die Seite neu (Ihre Eingaben bleiben dabei leider nicht erhalten)." };
  let data: AntragData;
  try {
    data = validateAntragForm(raw, v, ymdBerlin(ctx.now));
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  const ipRate = await consumeRate(db, "anmeldung.ip", ctx.ip, ctx.now);
  if (!ipRate.allowed) return { ok: false, error: rateLimitMessage(ipRate.retryAt) };
  // GATE-4c: IPv6 zusätzlich je /48 (sonst liefert ein Tunnel unbegrenzt viele /64-Kontingente)
  const net48 = ipv6Prefix48(ctx.ip);
  if (net48) {
    const r48 = await consumeRate(db, "anmeldung.ip48", net48, ctx.now);
    if (!r48.allowed) return { ok: false, error: rateLimitMessage(r48.retryAt) };
  }
  // GATE-4c: jeder Zeitstempel nur einmal (ein Skript kann nicht eine geladene Seite beliebig oft absenden)
  const stampKey = String(raw.stamp);
  if (!(await consumeRate(db, "anmeldung.stempel", stampKey, ctx.now)).allowed)
    return { ok: false, error: "Das Formular wurde schon abgeschickt. Bitte laden Sie die Seite neu, um einen weiteren Antrag zu stellen." };
  // je E-Mail: still (sonst ließe sich erfragen, ob für eine Adresse schon Anmeldungen laufen); Plus-Adressen zählen zusammen
  const mailRate = await consumeRate(db, "anmeldung.email", emailSubject(data.parent1Email), ctx.now);
  if (!mailRate.allowed) return SUBMIT_OK;
  const [active] = await db
    .select({ n: count() })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, v.id), eq(anmeldungAntraege.parent1Email, data.parent1Email), notInArray(anmeldungAntraege.status, INACTIVE)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_EMAIL) {
    await enqueueMail(db, { to: data.parent1Email, ...anmeldungLimitMail({ school: ctx.school, verfahren: v.name, max: MAX_ACTIVE_PER_EMAIL }), purpose: "anmeldung-limit" }, ctx.now);
    return SUBMIT_OK;
  }
  const token = newPublicToken();
  let created: { id: string };
  try {
    created = await insertAntrag(db, v.id, data, {
      now: ctx.now,
      status: "unbestaetigt",
      confirmTokenHash: hashPublicToken(token),
      confirmExpiresAt: new Date(ctx.now.getTime() + CONFIRM_HOURS * 3_600_000),
      future: true,
    });
  } catch (err) {
    // Termin inzwischen voll – das verrät nichts über Personen. Nichts angelegt → derselbe Stempel darf es noch einmal versuchen
    await resetRate(db, "anmeldung.stempel", stampKey);
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors };
    throw err;
  }
  await enqueueMail(
    db,
    { to: data.parent1Email, ...anmeldungConfirmMail({ school: ctx.school, verfahren: v.name, link: appUrl(`/anmeldung/bestaetigen/${token}`), hours: CONFIRM_HOURS }), purpose: "anmeldung-bestaetigen" },
    ctx.now,
  );
  // Audit ohne Personendaten: nur Verfahren und Antrag
  await audit(db, null, "anmeldung.eingegangen", created.id, { verfahren: v.id });
  return SUBMIT_OK;
}

// ---------------------------------------------------------------- Bestätigen (Double-Opt-In)

type TokenCtx = { ip: string; now: Date };

/** Token-Prüfungen je IP begrenzen (Raten von Links). false = gesperrt. */
async function tokenRate(db: Db, ctx: TokenCtx): Promise<boolean> {
  return (await consumeRate(db, "anmeldung.token", ctx.ip, ctx.now)).allowed;
}

async function byConfirmToken(db: Db, token: string, now: Date) {
  if (!isTokenShape(token)) return null;
  const hash = hashPublicToken(token);
  const [row] = await db
    .select({ a: anmeldungAntraege, verfahrenName: anmeldungVerfahren.name, verfahrenStatus: anmeldungVerfahren.status, closesAt: anmeldungVerfahren.closesAt })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .where(eq(anmeldungAntraege.confirmTokenHash, hash));
  if (!row || !sameHash(row.a.confirmTokenHash, hash)) return null;
  if (row.a.status !== "unbestaetigt" || !row.a.confirmExpiresAt || row.a.confirmExpiresAt <= now || row.verfahrenStatus === "abgeschlossen") return null;
  return row;
}

export type TokenLookup<T> = { state: "ok"; value: T } | { state: "invalid" } | { state: "limited" };

/** Für die Bestätigungsseite: gibt es einen offenen Link? Zeigt nur den Namen des Verfahrens. */
export async function confirmPreview(db: Db, token: string, ctx: TokenCtx): Promise<TokenLookup<{ verfahren: string }>> {
  if (!(await tokenRate(db, ctx))) return { state: "limited" };
  const row = await byConfirmToken(db, token, ctx.now);
  return row ? { state: "ok", value: { verfahren: row.verfahrenName } } : { state: "invalid" };
}

export interface ConfirmContext extends TokenCtx {
  school: string;
  state: StateCode;
}

/** Vorgangslink gültig bis Anmeldeschluss bzw. Ende des Termins (das Spätere) + 14 Tage (liegt im Service, GATE-4c). */
export const accessExpiry = accessExpiryFor;
export { ACCESS_GRACE_DAYS };

const dateOnly = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: TZ });

/**
 * Bestätigungslink einlösen: Antrag → „eingegangen“ bzw. „Termin vereinbart“, Vorgangslink (zweiter Token) erzeugen,
 * Mail mit Vorgangsnummer, Termin, Unterlagen und Links. Ist der Wunschtermin inzwischen vergeben (Haltezeit vorbei),
 * wird ohne Termin bestätigt – die Eltern wählen über den Vorgangslink neu.
 */
export async function confirmAntrag(db: Db, token: string, ctx: ConfirmContext): Promise<TokenLookup<{ accessToken: string; antragId: string }>> {
  if (!(await tokenRate(db, ctx))) return { state: "limited" };
  const row = await byConfirmToken(db, token, ctx.now);
  if (!row) return { state: "invalid" };
  const a = row.a;
  const accessToken = newPublicToken();
  const result = await db.transaction(async (tx) => {
    // erneut unter Sperre prüfen: zwei Klicks gleichzeitig lösen den Link nur einmal ein
    const [locked] = await tx.select({ status: anmeldungAntraege.status }).from(anmeldungAntraege).where(eq(anmeldungAntraege.id, a.id)).for("update");
    if (locked?.status !== "unbestaetigt") return null;
    let slot: { startsAt: Date; endsAt: Date } | null = null;
    let slotLost = false;
    if (a.slotId) {
      try {
        // GATE-4c (Code-L4): ein inzwischen vergangener Termin gilt als verloren – Eltern wählen über den Vorgangslink neu
        slot = await assertSlotFree(tx, a.verfahrenId, a.slotId, { exceptAntragId: a.id, now: ctx.now, future: true });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        slotLost = true;
      }
    }
    const expires = accessExpiry(row.closesAt, slot?.endsAt ?? null, ctx.now);
    await tx
      .update(anmeldungAntraege)
      .set({
        status: slot ? "termin" : "eingegangen",
        slotId: slot ? a.slotId : null,
        confirmedAt: ctx.now,
        confirmTokenHash: null,
        confirmExpiresAt: null,
        accessTokenHash: hashPublicToken(accessToken),
        accessExpiresAt: expires,
        retentionFrom: null,
        updatedAt: ctx.now,
      })
      .where(eq(anmeldungAntraege.id, a.id));
    await tx.insert(anmeldungEreignisse).values({ antragId: a.id, at: ctx.now, kind: "bestaetigt", text: slotLost ? "E-Mail bestätigt – Wunschtermin war inzwischen vergeben" : "E-Mail bestätigt" });
    return { slot, slotLost, expires };
  });
  if (!result) return { state: "invalid" };
  const [room] = a.slotId && result.slot ? await db.select({ name: rooms.name }).from(anmeldungSlots).innerJoin(rooms, eq(rooms.id, anmeldungSlots.roomId)).where(eq(anmeldungSlots.id, a.slotId)) : [];
  const number = `A-${a.year}-${String(a.seq).padStart(4, "0")}`;
  const link = appUrl(`/anmeldung/vorgang/${accessToken}`);
  await enqueueMail(
    db,
    {
      to: a.parent1Email,
      ...anmeldungReceivedMail({
        school: ctx.school,
        verfahren: row.verfahrenName,
        number,
        slot: result.slot ? slotText(result.slot, room?.name) : null,
        slotLost: result.slotLost,
        documents: anmeldungKatalog(ctx.state).checklist.map((c) => c.label),
        link,
        icsLink: result.slot ? `${link}/termin.ics` : null,
        validUntil: dateOnly.format(result.expires),
      }),
      purpose: "anmeldung-eingegangen",
    },
    ctx.now,
  );
  await audit(db, null, "anmeldung.bestaetigt", a.id, { verfahren: a.verfahrenId });
  await gongNewAntrag(db, a.verfahrenId);
  return { state: "ok", value: { accessToken, antragId: a.id } };
}


// ---------------------------------------------------------------- Vorgang (Bearbeitungslink)

/** Antrag zum Vorgangslink – nur gültige, nicht abgelaufene Links; zeitkonstanter Vergleich des Hashs. */
export async function byAccessToken(db: Db, token: string, now: Date) {
  if (!isTokenShape(token)) return null;
  const hash = hashPublicToken(token);
  const [a] = await db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.accessTokenHash, hash));
  if (!a || !sameHash(a.accessTokenHash, hash) || !a.accessExpiresAt || a.accessExpiresAt <= now) return null;
  return a;
}

export interface VorgangView {
  antragId: string;
  verfahrenId: string;
  number: string;
  status: AntragStatus;
  verfahren: string;
  slot: { id: string; startsAt: Date; endsAt: Date; room: string | null } | null;
  /** Termin ändern und zurückziehen nur, solange nicht entschieden und das Verfahren nicht abgeschlossen ist */
  open: boolean;
  validUntil: Date | null;
}

/**
 * Was die Eltern über den Vorgangslink sehen: nur Nummer, Verfahren, Stand und Termin – keine Namen oder Anschrift
 * (wer den Link abgreift, erfährt nichts über die Familie, Q-32).
 */
export async function vorgangView(db: Db, a: typeof anmeldungAntraege.$inferSelect): Promise<VorgangView> {
  const [v] = await db.select({ name: anmeldungVerfahren.name, status: anmeldungVerfahren.status }).from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, a.verfahrenId));
  const [slot] = a.slotId
    ? await db
        .select({ id: anmeldungSlots.id, startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name })
        .from(anmeldungSlots)
        .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
        .where(eq(anmeldungSlots.id, a.slotId))
    : [];
  return {
    antragId: a.id,
    verfahrenId: a.verfahrenId,
    number: `A-${a.year}-${String(a.seq).padStart(4, "0")}`,
    status: a.status,
    verfahren: v?.name ?? "",
    slot: slot ?? null,
    open: v?.status !== "abgeschlossen" && (OPEN_STATUSES as readonly string[]).includes(a.status),
    validUntil: a.accessExpiresAt,
  };
}

/** Vorgangsseite: Link prüfen (Rate-Limit je IP) und Ansicht laden. */
export async function loadVorgang(db: Db, token: string, ctx: TokenCtx): Promise<TokenLookup<VorgangView>> {
  if (!(await tokenRate(db, ctx))) return { state: "limited" };
  const a = await byAccessToken(db, token, ctx.now);
  return a ? { state: "ok", value: await vorgangView(db, a) } : { state: "invalid" };
}

// ---------------------------------------------------------------- Vorgang ändern (P4-35)

/** Wer handelt: Eltern über den Vorgangslink oder über ihr Konto (P4-34b). */
export type VorgangRef = { token: string } | { antragId: string; viewer: PermissionSet };

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const LIMITED: ActionResult = { ok: false, error: "Zu viele Versuche in kurzer Zeit. Bitte später noch einmal versuchen." };
const INVALID: ActionResult = { ok: false, error: "Der Link ist ungültig oder abgelaufen." };

async function resolveRef(db: Db, ref: VorgangRef, ctx: TokenCtx): Promise<TokenLookup<typeof anmeldungAntraege.$inferSelect>> {
  if ("token" in ref) {
    if (!(await tokenRate(db, ctx))) return { state: "limited" };
    const a = await byAccessToken(db, ref.token, ctx.now);
    return a ? { state: "ok", value: a } : { state: "invalid" };
  }
  if (ref.viewer.role !== "eltern" || typeof ref.antragId !== "string" || ref.antragId.length > 64) return { state: "invalid" };
  const [a] = await db
    .select()
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.id, ref.antragId), eq(anmeldungAntraege.parentUserId, ref.viewer.userId)));
  return a ? { state: "ok", value: a } : { state: "invalid" };
}

const numberOf = (a: { year: number; seq: number }) => `A-${a.year}-${String(a.seq).padStart(4, "0")}`;

/** Freie künftige Termine für die Terminänderung (ohne den eigenen). */
export async function vorgangSlots(db: Db, verfahrenId: string, now = new Date()) {
  return publicSlots(db, verfahrenId, now);
}

/** Termin ändern (nur offene Anträge, nur künftige freie Termine desselben Verfahrens); Mail an die Eltern. */
export async function changeVorgangSlot(db: Db, ref: VorgangRef, slotId: string, ctx: TokenCtx & { school: string }): Promise<ActionResult> {
  const r = await resolveRef(db, ref, ctx);
  if (r.state === "limited") return LIMITED;
  if (r.state === "invalid") return INVALID;
  const a = r.value;
  const view = await vorgangView(db, a);
  if (!view.open) return { ok: false, error: "Über diese Anmeldung ist schon entschieden – bitte an das Sekretariat wenden." };
  if (typeof slotId !== "string" || !slotId || slotId.length > 64) return { ok: false, error: "Bitte einen Termin wählen." };
  if (slotId === a.slotId) return { ok: true, message: "Der Termin ist unverändert." };
  try {
    await setAntragSlot(db, null, a.id, slotId, ctx.now, { future: true });
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Termin nicht möglich" };
    throw err;
  }
  const [s] = await db
    .select({ startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name })
    .from(anmeldungSlots)
    .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
    .where(eq(anmeldungSlots.id, slotId));
  await enqueueMail(db, { to: a.parent1Email, ...anmeldungSlotMail({ school: ctx.school, number: numberOf(a), slot: s ? slotText(s, s.room) : null, bySchool: false }), purpose: "anmeldung-termin" }, ctx.now);
  await audit(db, "token" in ref ? null : ref.viewer.userId, "anmeldung.termin.eltern", a.id);
  return { ok: true, message: "Der Termin ist geändert. Wir haben Ihnen eine Bestätigung per E-Mail geschickt." };
}

/** Anmeldung zurückziehen (nur offene Anträge): Termin wird frei, Löschfrist beginnt; Mail an die Eltern. */
export async function withdrawVorgang(db: Db, ref: VorgangRef, ctx: TokenCtx & { school: string }): Promise<ActionResult> {
  const r = await resolveRef(db, ref, ctx);
  if (r.state === "limited") return LIMITED;
  if (r.state === "invalid") return INVALID;
  const a = r.value;
  if (!(await vorgangView(db, a)).open) return { ok: false, error: "Über diese Anmeldung ist schon entschieden – bitte an das Sekretariat wenden." };
  try {
    await setAntragStatus(db, null, a.id, "zurueckgezogen", { now: ctx.now });
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: Object.values(err.fieldErrors)[0] ?? "Nicht möglich" };
    throw err;
  }
  await enqueueMail(db, { to: a.parent1Email, ...anmeldungWithdrawnMail({ school: ctx.school, number: numberOf(a) }), purpose: "anmeldung-zurueckgezogen" }, ctx.now);
  await audit(db, "token" in ref ? null : ref.viewer.userId, "anmeldung.zurueckgezogen", a.id);
  return { ok: true, message: "Ihre Anmeldung ist zurückgezogen." };
}

// ---------------------------------------------------------------- Aufräumen (P4-35)

/**
 * Unbestätigte Anträge nach Ablauf des Bestätigungslinks (48 h) vollständig löschen – eigener Job im Minutentakt, nicht erst
 * der nächtliche Löschlauf. Verlauf löscht die DB mit (cascade). Gibt nur die Anzahl zurück.
 */
export async function purgeUnconfirmed(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONFIRM_HOURS * 3_600_000);
  const rows = await db
    .delete(anmeldungAntraege)
    .where(
      and(
        eq(anmeldungAntraege.status, "unbestaetigt"),
        or(lt(anmeldungAntraege.confirmExpiresAt, now), and(isNull(anmeldungAntraege.confirmExpiresAt), lt(anmeldungAntraege.createdAt, cutoff))),
      ),
    )
    .returning({ id: anmeldungAntraege.id });
  return rows.length;
}
