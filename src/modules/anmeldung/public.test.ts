import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, auditLog, mailOutbox, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { hashPublicToken } from "@/core/public-token";
import { consumeRate } from "@/core/rate-limit";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  accessExpiry,
  ageOn,
  confirmAntrag,
  confirmPreview,
  formStamp,
  liveSlots,
  loadVorgang,
  MAX_ACTIVE_PER_EMAIL,
  publicVerfahren,
  submitAntrag,
  SUBMIT_OK,
  validateAntragForm,
} from "./public";
import { addSlots, createVerfahren, insertAntrag, listSlots, publishVerfahren, setAntragSlot, type AntragData } from "./service";

const SABINE = "u-sabine.kowalski";
const now = new Date("2027-02-05T10:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

/** Ziffern in Namen sind unzulässig – Zahl als Buchstaben */
const letters = (i: number) => String(i).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);

const form = (i: number, extra: Record<string, string> = {}): Record<string, string> => ({
  childFirstName: `Kind${letters(i)}`,
  childLastName: "Muster-Öztürk",
  childBirthDate: "2016-05-01",
  primarySchool: "GS Am Park",
  parent1Name: `Elternteil ${letters(i)}`,
  parent1Email: `Eltern${i}@Example.org`,
  addressStreet: "Lindenweg 1",
  addressZip: "12345",
  addressCity: "Musterstadt",
  consent: "on",
  website: "",
  ...extra,
});

const verfahrenLike = { kind: "klasse5" as const, fields: { geschwister: true, zweitwunsch: true, elternteil2: true, hinweise: true }, targetGradeLevel: 5, schoolYearStartsOn: "2027-08-01" };

describe("Schulanmeldung öffentlich – Eingaben (rein)", () => {
  const ok = (extra: Record<string, string> = {}) => validateAntragForm({ ...form(1), slotId: "s1", ...extra }, verfahrenLike, "2027-02-05");
  const errs = (extra: Record<string, string>) => {
    try {
      ok(extra);
    } catch (e) {
      return (e as ValidationError).fieldErrors;
    }
    return null;
  };

  it("gültige Eingaben: getrimmt, E-Mail klein, optionale Felder nur, wenn eingeschaltet", () => {
    const d = ok({ childFirstName: "  Lena  Marie ", sibling: "on", siblingNote: "Tom, 7b", hints: "Kommt mit dem Bus." });
    expect(d).toMatchObject({ childFirstName: "Lena Marie", parent1Email: "eltern1@example.org", sibling: true, siblingNote: "Tom, 7b", hints: "Kommt mit dem Bus.", slotId: "s1" });
    const off = validateAntragForm({ ...form(1), slotId: "s1", sibling: "on", hints: "x", parent2Name: "Max" }, { ...verfahrenLike, fields: { geschwister: false, zweitwunsch: false, elternteil2: false, hinweise: false } }, "2027-02-05");
    expect(off).toMatchObject({ sibling: false, hints: null, parent2Name: null, secondChoiceSchool: null });
    // GATE-4c (L7): zerlegte Umlaute werden zusammengesetzt (cp1252-Export)
    expect(ok({ childLastName: "Müller" }).childLastName).toBe("Müller");
  });

  it("Q5-23: E-Mail des zweiten Elternteils – optional, nur mit Namen und Bestätigung, nicht gleich Elternteil 1", () => {
    expect(ok()).toMatchObject({ parent2Name: null, parent2Email: null });
    expect(ok({ parent2Name: "Bernd Muster", parent2Email: " Bernd@Example.org ", parent2Consent: "on" })).toMatchObject({ parent2Name: "Bernd Muster", parent2Email: "bernd@example.org" });
    // Name ohne E-Mail wie bisher
    expect(ok({ parent2Name: "Bernd Muster" })).toMatchObject({ parent2Name: "Bernd Muster", parent2Email: null });
    expect(errs({ parent2Name: "Bernd Muster", parent2Email: "bernd@example.org" })).toMatchObject({ parent2Consent: /weiß/ });
    expect(errs({ parent2Email: "bernd@example.org", parent2Consent: "on" })).toMatchObject({ parent2Name: /Name/ });
    expect(errs({ parent2Name: "Bernd Muster", parent2Email: "kein-at", parent2Consent: "on" })).toMatchObject({ parent2Email: /Gültige/ });
    expect(errs({ parent2Name: "Bernd Muster", parent2Email: "ELTERN1@example.org", parent2Consent: "on" })).toMatchObject({ parent2Email: /andere Adresse/ });
    // Feld im Verfahren aus → ignoriert
    const off = validateAntragForm({ ...form(1), slotId: "s1", parent2Name: "Bernd", parent2Email: "bernd@example.org" }, { ...verfahrenLike, fields: { ...verfahrenLike.fields, elternteil2: false } }, "2027-02-05");
    expect(off).toMatchObject({ parent2Name: null, parent2Email: null });
  });

  it("Alter passend zum Jahrgang (Klasse 5: 9–13 zum Schuljahresbeginn)", () => {
    expect(ageOn("2016-08-02", "2027-08-01")).toBe(10);
    expect(ageOn("2016-08-01", "2027-08-01")).toBe(11);
    expect(ageOn("2016-02-30", "2027-08-01")).toBeNull();
    expect(errs({ childBirthDate: "2020-01-01" })).toMatchObject({ childBirthDate: /erwartet 9 bis 13/ });
    expect(errs({ childBirthDate: "2030-01-01" })).toMatchObject({ childBirthDate: /Gültiges/ });
    expect(errs({ childBirthDate: "kaputt" })).toMatchObject({ childBirthDate: /Gültiges/ });
  });

  it("strenge Prüfung: Pflichtfelder, Längen, Zeichen, keine Links, Einwilligung", () => {
    expect(errs({ childFirstName: "", parent1Email: "kein-mail", addressZip: "1", consent: "", slotId: "" })).toMatchObject({
      childFirstName: /angeben/,
      parent1Email: /Gültige/,
      addressZip: /prüfen/,
      consent: /Datenschutzhinweise/,
      slotId: /Gesprächstermin/,
    });
    expect(errs({ childLastName: "<svg onload=alert(1)>" })).toMatchObject({ childLastName: /Buchstaben/ });
    expect(errs({ primarySchool: "GS\u0000" })).toMatchObject({ primarySchool: /Unzulässige/ });
    expect(errs({ parent1Name: "a".repeat(121) })).toMatchObject({ parent1Name: /kürzer/ });
    expect(errs({ hints: "x".repeat(301) })).toMatchObject({ hints: /300/ });
    expect(errs({ hints: "Mehr unter https://spam.example" })).toMatchObject({ hints: /Links/ });
    expect(errs({ hints: "billig kaufen bei www.spam.biz" })).toMatchObject({ hints: /Links/ });
    expect(errs({ hints: "Infos auf spam.ru" })).toMatchObject({ hints: /Links/ });
    expect(errs({ childFirstName: "a".repeat(5000) })).toMatchObject({ childFirstName: /zu lang/ });
    // HTML im Freitext ist erlaubt, bleibt aber Text (React maskiert)
    expect(ok({ hints: "<b>fett</b> & Co." }).hints).toBe("<b>fett</b> & Co.");
  });
});

describe("Schulanmeldung öffentlich – Ablauf mit DB", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let vid: string;
  const ctx = (ip: string, t = now) => ({ ip, now: t, school: "Gesamtschule am Lindenhof", state: "NW" as const });
  // Zeitstempel vom Laden der Seite: 10 s vor dem Absenden
  const stamp = (t = now) => formStamp(vid, new Date(t.getTime() - 10_000));
  const submit = (i: number, ip: string, extra: Record<string, string> = {}, t = now) => submitAntrag(h.db, vid, { ...form(i), stamp: stamp(t), ...extra }, ctx(ip, t));
  const lastMailTo = async (to: string) =>
    (await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, to)).orderBy(desc(mailOutbox.createdAt), desc(mailOutbox.id)))[0];
  const tokenFrom = (text: string, path: string) => new RegExp(`${path}([A-Za-z0-9_-]{43})`).exec(text)?.[1];
  const antraegeOf = (email: string) => h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.parent1Email, email));

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, SABINE);
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, {
      name: "Anmeldung Klasse 5 – 2027/28",
      kind: "klasse5",
      targetSchoolYearId: "sj-2027-28",
      targetGradeLevel: 5,
      opensAt: "2027-02-01T08:00",
      closesAt: "2027-02-28T18:00",
    });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10", "2027-02-11"], windows: [{ from: "14:00", to: "16:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, at(-86_400_000));
  });
  afterAll(async () => h?.close());

  const slotIds = async () => (await listSlots(h.db, vid, now)).map((s) => s.id);

  it("nur offene Verfahren im Zeitraum", async () => {
    expect(await publicVerfahren(h.db, vid, now)).toMatchObject({ id: vid, schoolYearStartsOn: "2027-08-01" });
    expect(await publicVerfahren(h.db, vid, new Date("2027-03-01T10:00:00Z"))).toBeNull();
    expect(await publicVerfahren(h.db, "gibts-nicht", now)).toBeNull();
    expect(await submitAntrag(h.db, "gibts-nicht", form(1), ctx("10.0.0.1"))).toMatchObject({ ok: false, error: /nicht geöffnet/ });
  });

  it("Einreichen: Antrag unbestätigt, Token nur als Hash, Bestätigungslink per Mail, Audit ohne Personendaten", async () => {
    const [s1] = await slotIds();
    expect(await submit(1, "10.0.1.1", { slotId: s1! })).toEqual(SUBMIT_OK);
    const [a] = await antraegeOf("eltern1@example.org");
    expect(a).toMatchObject({ status: "unbestaetigt", slotId: s1, confirmedAt: null, accessTokenHash: null, retentionFrom: now });
    expect(a!.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.confirmExpiresAt).toEqual(at(48 * 3_600_000));
    const mail = await lastMailTo("eltern1@example.org");
    expect(mail).toMatchObject({ purpose: "anmeldung-bestaetigen" });
    expect(mail!.text).not.toContain("Kindb"); // keine Namen in Mails
    const token = tokenFrom(mail!.text, "/anmeldung/bestaetigen/");
    expect(token).toBeTruthy();
    expect(hashPublicToken(token!)).toBe(a!.confirmTokenHash);
    expect(JSON.stringify(a)).not.toContain(token!);
    const [log] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "anmeldung.eingegangen"), eq(auditLog.target, a!.id)));
    expect(log).toMatchObject({ actorId: null, meta: { verfahren: vid } });
    expect(JSON.stringify(log)).not.toMatch(/eltern1|Kindb|Muster/);
  });

  it("Bots: Honeypot oder zu schnelles Absenden → gleiche Antwort, nichts gespeichert, keine Mail; kaputter Zeitstempel → Hinweis", async () => {
    const [s1] = await slotIds();
    expect(await submit(2, "10.0.2.1", { slotId: s1!, website: "http://spam" })).toEqual(SUBMIT_OK);
    expect(await submitAntrag(h.db, vid, { ...form(2), slotId: s1!, stamp: formStamp(vid, at(-1_000)) }, ctx("10.0.2.1"))).toEqual(SUBMIT_OK);
    expect(await antraegeOf("eltern2@example.org")).toHaveLength(0);
    expect(await lastMailTo("eltern2@example.org")).toBeUndefined();
    expect(await submitAntrag(h.db, vid, { ...form(2), slotId: s1!, stamp: "x.y" }, ctx("10.0.2.1"))).toMatchObject({ ok: false, error: /abgelaufen/ });
    expect(await submitAntrag(h.db, vid, { ...form(2), slotId: s1!, stamp: formStamp("anderes-verfahren", at(-10_000)) }, ctx("10.0.2.1"))).toMatchObject({ ok: false });
  });

  it("Rate-Limit je IP: 10 Einreichungen je Stunde, die 11. bekommt den Hinweis; andere IP geht weiter", async () => {
    const [, , s3, s4] = await slotIds();
    const slots = [s3, s4];
    for (let i = 0; i < 10; i++)
      expect(await submit(100 + i, "10.0.3.1", { slotId: slots[i % 2]!, parent1Email: `ip${i}@example.org` }, at(i * 1000)), `Einreichung ${i + 1}`).not.toMatchObject({
        error: expect.stringMatching(/Zu viele/),
      });
    expect(await submit(110, "10.0.3.1", { slotId: s3!, parent1Email: "ip10@example.org" })).toMatchObject({ ok: false, error: /Zu viele Anfragen/ });
    expect(await antraegeOf("ip10@example.org")).toHaveLength(0);
    // andere Adresse: eigenes Kontingent (Termin ist inzwischen voll – der Hinweis kommt also vom Termin, nicht vom Limit)
    expect(await submit(111, "10.0.3.2", { slotId: s3!, parent1Email: "ip11@example.org" })).toMatchObject({ ok: false, fieldErrors: { slotId: /ausgebucht/ } });
  });

  it("je E-Mail: höchstens 4 offene Anträge (Hinweis-Mail nur an die Adresse), danach still – Antwort immer gleich", async () => {
    const ids = await slotIds();
    const email = "viel@example.org";
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await submit(200 + i, `10.0.4.${i}`, { slotId: ids[(i % 4) + 4]!, parent1Email: email }));
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(SUBMIT_OK))).toBe(true);
    expect(await antraegeOf(email)).toHaveLength(MAX_ACTIVE_PER_EMAIL);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, email));
    expect(mails.map((m) => m.purpose).sort()).toEqual([...Array(4).fill("anmeldung-bestaetigen"), "anmeldung-limit"].sort());
    // die Antwort für eine neue Adresse sieht genauso aus
    expect(await submit(206, "10.0.4.9", { slotId: ids[0]!, parent1Email: "neu@example.org" })).toEqual(results[5]);
  });

  it("GATE-4c: Zeitstempel nur einmal; Plus-Adressen zählen zusammen; IPv6 zusätzlich je /48", async () => {
    const id4 = await createVerfahren(h.db, sabine, { name: "Missbrauch", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, id4, { days: ["2027-02-17", "2027-02-18"], windows: [{ from: "08:00", to: "14:00" }], durationMinutes: 30, parallel: 1 });
    await publishVerfahren(h.db, sabine, id4, at(-1000));
    const slots = (await listSlots(h.db, id4, now)).map((x) => x.id);
    let next = 0;
    const st = () => formStamp(id4, at(-10_000));
    const sub = (i: number, ip: string, extra: Record<string, string> = {}) => submitAntrag(h.db, id4, { ...form(i), slotId: slots[next++]!, stamp: st(), ...extra }, ctx(ip));
    // derselbe Stempel zweimal (Skript lädt die Seite einmal und sendet beliebig oft)
    const once = st();
    expect(await sub(600, "10.0.12.1", { stamp: once })).toEqual(SUBMIT_OK);
    expect(await sub(601, "10.0.12.2", { stamp: once })).toMatchObject({ ok: false, error: /schon abgeschickt/ });
    expect(await antraegeOf("eltern601@example.org")).toHaveLength(0);
    // Termin voll → nichts angelegt → derselbe Stempel darf mit anderem Termin noch einmal
    const retry = st();
    expect(await sub(602, "10.0.12.3", { stamp: retry, slotId: slots[0]! })).toMatchObject({ ok: false, fieldErrors: { slotId: /ausgebucht/ } });
    expect(await sub(602, "10.0.12.3", { stamp: retry })).toEqual(SUBMIT_OK);
    expect(await antraegeOf("eltern602@example.org")).toHaveLength(1);
    // Plus-Adressen: 5 je Tag für name+…@ zusammen, die 6. still ohne Antrag
    for (let i = 0; i < 6; i++) expect(await sub(610 + i, `10.0.13.${i}`, { parent1Email: `plus+${i}@example.org` })).toEqual(SUBMIT_OK);
    for (let i = 0; i < 5; i++) expect(await antraegeOf(`plus+${i}@example.org`)).toHaveLength(1);
    expect(await antraegeOf("plus+5@example.org")).toHaveLength(0);
    // IPv6: eigenes /64, aber das /48 ist ausgeschöpft → Hinweis; anderes /48 geht
    for (let i = 0; i < 30; i++) await consumeRate(h.db, "anmeldung.ip48", "2001:db8:77::/48", now);
    expect(await sub(620, "2001:db8:77:5::/64")).toMatchObject({ ok: false, error: /Zu viele Anfragen/ });
    expect(await sub(621, "2001:db8:78:5::/64")).toEqual(SUBMIT_OK);
  });

  it("GATE-4c: freie Termine live nur für offene Verfahren und je IP begrenzt", async () => {
    expect((await liveSlots(h.db, vid, { ip: "10.0.14.1", now })).length).toBeGreaterThan(0);
    // nach Anmeldeschluss bzw. unbekanntes Verfahren: nichts
    expect(await liveSlots(h.db, vid, { ip: "10.0.14.1", now: new Date("2027-03-01T10:00:00Z") })).toEqual([]);
    expect(await liveSlots(h.db, "gibts-nicht", { ip: "10.0.14.1", now })).toEqual([]);
    for (let i = 0; i < 120; i++) await consumeRate(h.db, "anmeldung.termine", "10.0.14.2", now);
    expect(await liveSlots(h.db, vid, { ip: "10.0.14.2", now })).toEqual([]);
  });

  it("Bestätigen per Token: Vorgangsnummer, Vorgangslink (zweiter Token), Mail; einmalig; falsche Tokens verraten nichts", async () => {
    const mail = await lastMailTo("eltern1@example.org");
    const token = tokenFrom(mail!.text, "/anmeldung/bestaetigen/")!;
    expect(await confirmPreview(h.db, token, { ip: "10.0.5.1", now })).toEqual({ state: "ok", value: { verfahren: "Anmeldung Klasse 5 – 2027/28" } });
    expect(await confirmPreview(h.db, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { ip: "10.0.5.1", now })).toEqual({ state: "invalid" });
    expect(await confirmPreview(h.db, "kurz", { ip: "10.0.5.1", now })).toEqual({ state: "invalid" });
    const r = await confirmAntrag(h.db, token, { ...ctx("10.0.5.1"), now: at(60_000) });
    expect(r.state).toBe("ok");
    const accessToken = r.state === "ok" ? r.value.accessToken : "";
    const [a] = await antraegeOf("eltern1@example.org");
    expect(a).toMatchObject({ status: "termin", confirmedAt: at(60_000), confirmTokenHash: null, retentionFrom: null, accessTokenHash: hashPublicToken(accessToken) });
    expect(a!.accessExpiresAt).toEqual(new Date("2027-03-14T17:00:00Z")); // Anmeldeschluss + 14 Tage
    const received = await lastMailTo("eltern1@example.org");
    expect(received).toMatchObject({ purpose: "anmeldung-eingegangen" });
    expect(received!.text).toContain("A-2027-");
    expect(received!.text).toContain(`/anmeldung/vorgang/${accessToken}`);
    expect(received!.text).toContain("termin.ics");
    expect(received!.text).toContain("Anmeldeschein der Grundschule");
    // ein zweites Mal gilt der Link nicht
    expect(await confirmAntrag(h.db, token, ctx("10.0.5.1"))).toEqual({ state: "invalid" });
    // Vorgangslink: nur Nummer, Stand, Termin
    const v = await loadVorgang(h.db, accessToken, { ip: "10.0.5.2", now: at(120_000) });
    expect(v).toMatchObject({ state: "ok", value: { status: "termin", open: true, verfahren: "Anmeldung Klasse 5 – 2027/28" } });
    expect(JSON.stringify(v)).not.toMatch(/Kindb|eltern1|Lindenweg/);
    expect(await loadVorgang(h.db, accessToken, { ip: "10.0.5.2", now: new Date("2027-03-15T00:00:00Z") })).toEqual({ state: "invalid" });
    expect(await loadVorgang(h.db, token, { ip: "10.0.5.2", now })).toEqual({ state: "invalid" });
  });

  it("Bestätigungslink läuft nach 48 h ab", async () => {
    const ids = await slotIds();
    await submit(3, "10.0.6.1", { slotId: ids[1]! });
    const token = tokenFrom((await lastMailTo("eltern3@example.org"))!.text, "/anmeldung/bestaetigen/")!;
    expect(await confirmAntrag(h.db, token, { ...ctx("10.0.6.1"), now: at(48 * 3_600_000 + 1) })).toEqual({ state: "invalid" });
  });

  it("Token-Prüfungen je IP begrenzt (20 je 15 min)", async () => {
    for (let i = 0; i < 20; i++) expect((await confirmPreview(h.db, "x".repeat(43), { ip: "10.0.7.1", now })).state).toBe("invalid");
    expect(await confirmPreview(h.db, "x".repeat(43), { ip: "10.0.7.1", now })).toEqual({ state: "limited" });
    expect(await loadVorgang(h.db, "x".repeat(43), { ip: "10.0.7.1", now })).toEqual({ state: "limited" });
    expect((await confirmPreview(h.db, "x".repeat(43), { ip: "10.0.7.1", now: at(16 * 60_000) })).state).toBe("invalid");
  });

  it("Unbestätigte halten den Termin nur 2 h; wer später bestätigt und keinen Platz mehr hat, wird ohne Termin bestätigt", async () => {
    const id2 = await createVerfahren(h.db, sabine, { name: "Seiteneinstieg", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, id2, { days: ["2027-02-12"], windows: [{ from: "10:00", to: "10:30" }], durationMinutes: 30, parallel: 1 });
    await publishVerfahren(h.db, sabine, id2, at(-1000));
    const [slot] = await listSlots(h.db, id2, now);
    const sub = (i: number, t: Date) => submitAntrag(h.db, id2, { ...form(i), slotId: slot!.id, stamp: formStamp(id2, new Date(t.getTime() - 10_000)) }, ctx(`10.0.8.${i % 250}`, t));
    expect(await sub(501, now)).toEqual(SUBMIT_OK);
    // innerhalb der Haltezeit belegt
    expect(await sub(502, at(60 * 60_000))).toMatchObject({ ok: false, fieldErrors: { slotId: /ausgebucht/ } });
    // danach wieder frei – der zweite bucht und bestätigt
    expect(await sub(502, at(3 * 3_600_000))).toEqual(SUBMIT_OK);
    const t2 = tokenFrom((await lastMailTo("eltern502@example.org"))!.text, "/anmeldung/bestaetigen/")!;
    expect((await confirmAntrag(h.db, t2, { ...ctx("10.0.8.9"), now: at(3 * 3_600_000 + 60_000) })).state).toBe("ok");
    // der erste bestätigt spät: Termin ist weg → eingegangen ohne Termin, Mail sagt es
    const t1 = tokenFrom((await lastMailTo("eltern501@example.org"))!.text, "/anmeldung/bestaetigen/")!;
    expect((await confirmAntrag(h.db, t1, { ...ctx("10.0.8.9"), now: at(4 * 3_600_000) })).state).toBe("ok");
    const [first] = await h.db.select().from(anmeldungAntraege).where(and(eq(anmeldungAntraege.verfahrenId, id2), eq(anmeldungAntraege.parent1Email, "eltern501@example.org")));
    expect(first).toMatchObject({ status: "eingegangen", slotId: null });
    expect((await lastMailTo("eltern501@example.org"))!.text).toContain("Wunschtermin war inzwischen vergeben");
  });

  it("GATE-4c: Bestätigung nach Terminbeginn → ohne Termin (L4); späterer Termin verlängert den Vorgangslink (L5)", async () => {
    const id5 = await createVerfahren(h.db, sabine, { name: "Spät", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, id5, { days: ["2027-02-06"], windows: [{ from: "08:00", to: "08:30" }], durationMinutes: 30, parallel: 1 });
    await addSlots(h.db, sabine, id5, { days: ["2027-04-20"], windows: [{ from: "09:00", to: "09:30" }], durationMinutes: 30, parallel: 1 });
    await publishVerfahren(h.db, sabine, id5, at(-1000));
    const [early, late] = await listSlots(h.db, id5, now);
    expect(await submitAntrag(h.db, id5, { ...form(700), slotId: early!.id, stamp: formStamp(id5, at(-10_000)) }, ctx("10.0.15.1"))).toEqual(SUBMIT_OK);
    const tok = tokenFrom((await lastMailTo("eltern700@example.org"))!.text, "/anmeldung/bestaetigen/")!;
    // bestätigt am 06.02. um 09:00 Berliner Zeit – der Termin um 08:00 ist vorbei (innerhalb der Haltezeit von 2 h)
    expect((await confirmAntrag(h.db, tok, { ...ctx("10.0.15.1"), now: new Date("2027-02-06T08:00:00Z") })).state).toBe("ok");
    const [a] = await antraegeOf("eltern700@example.org");
    expect(a).toMatchObject({ status: "eingegangen", slotId: null });
    expect(a!.accessExpiresAt).toEqual(new Date("2027-03-14T17:00:00Z"));
    // Sekretariat legt einen Termin nach Anmeldeschluss + 14 Tage → Link gilt bis Terminende + 14 Tage
    await setAntragSlot(h.db, sabine, a!.id, late!.id, new Date("2027-02-07T10:00:00Z"));
    const [b] = await antraegeOf("eltern700@example.org");
    expect(b!.accessExpiresAt).toEqual(new Date(late!.endsAt.getTime() + 14 * 86_400_000));
  });

  it("Rennen: parallele Buchungen nehmen nie mehr Plätze als der Termin hat; paralleles Bestätigen löst nur einmal ein", async () => {
    const id3 = await createVerfahren(h.db, sabine, { name: "Rennen", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, id3, { days: ["2027-02-15"], windows: [{ from: "10:00", to: "10:30" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, id3, at(-1000));
    const [slot] = await listSlots(h.db, id3, now);
    const data = (i: number): AntragData => ({ ...validateAntragForm({ ...form(300 + i), slotId: slot!.id }, verfahrenLike, "2027-02-05") });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => insertAntrag(h.db, id3, data(i), { now, future: true })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    expect((await listSlots(h.db, id3, now))[0]).toMatchObject({ booked: 2, free: 0 });
    // ohne Nummernvergabe (die Wiederholung bei doppelter Nummer würde ein Rennen verdecken): gleichzeitiges Umbuchen
    await addSlots(h.db, sabine, id3, { days: ["2027-02-16"], windows: [{ from: "10:00", to: "10:30" }], durationMinutes: 30, parallel: 1 });
    const one = (await listSlots(h.db, id3, now)).find((s) => s.capacity === 1)!;
    const loose = await Promise.all(Array.from({ length: 5 }, (_, i) => insertAntrag(h.db, id3, { ...data(10 + i), slotId: null }, { now, status: "eingegangen" })));
    const moves = await Promise.allSettled(loose.map((a) => setAntragSlot(h.db, sabine, a.id, one.id, now)));
    expect(moves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listSlots(h.db, id3, now)).find((s) => s.id === one.id)).toMatchObject({ booked: 1 });

    // derselbe Bestätigungslink zweimal gleichzeitig
    const ids = await slotIds();
    await submit(400, "10.0.9.1", { slotId: ids[1]! });
    const tok = tokenFrom((await lastMailTo("eltern400@example.org"))!.text, "/anmeldung/bestaetigen/")!;
    const both = await Promise.all([confirmAntrag(h.db, tok, ctx("10.0.9.2")), confirmAntrag(h.db, tok, ctx("10.0.9.3"))]);
    expect(both.map((b) => b.state).sort()).toEqual(["invalid", "ok"]);
    expect((await h.db.select().from(mailOutbox).where(and(eq(mailOutbox.to, "eltern400@example.org"), eq(mailOutbox.purpose, "anmeldung-eingegangen")))).length).toBe(1);
  });

  it("Vorgangslink-Ablauf: Anmeldeschluss bzw. Termin (das Spätere) + 14 Tage", () => {
    const closes = new Date("2027-02-28T17:00:00Z");
    expect(accessExpiry(closes, null, now)).toEqual(new Date("2027-03-14T17:00:00Z"));
    expect(accessExpiry(closes, new Date("2027-03-05T10:00:00Z"), now)).toEqual(new Date("2027-03-19T10:00:00Z"));
  });
});
