import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, mailOutbox, users, verifications } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { createUser, listUsers, sendEmailConfirmation, updateUser, ValidationError } from "@/modules/verwaltung/users";
import { executeImport, parseStudentCsv, planImport } from "@/modules/verwaltung/import";
import {
  confirmEmailChange,
  EmailChangeError,
  isPlaceholderEmail,
  normalizeEmail,
  pendingEmailChange,
  realEmail,
  removeOwnEmail,
  requestEmailChange,
} from "./email";

const JANA = "u-jana.brandt";
const LEA = "u-lea.schaefer";
const ADMIN = "u-admin";
const opts = { school: "Lindenhof" };
const tokenOf = (link: string | null) => link!.split("/konto/email/")[1]!;

describe("E-Mail-Adressen (Q5-04)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  const userRow = async (id: string) => (await h.db.select().from(users).where(eq(users.id, id)))[0]!;

  it("rein: Platzhalter erkennen, Eingaben normalisieren", () => {
    expect(isPlaceholderEmail("jana.brandt@schulos.local")).toBe(true);
    expect(isPlaceholderEmail("jana.brandt@lindenhof.schulos.local")).toBe(true);
    expect(isPlaceholderEmail("jana@notschulos.local.de")).toBe(false);
    expect(realEmail("jana.brandt@schulos.local")).toBeNull();
    expect(realEmail("Jana@Example.org")).toBe("Jana@Example.org");
    expect(normalizeEmail("  Jana@Example.ORG ")).toEqual({ email: "jana@example.org", error: null });
    expect(normalizeEmail("")).toEqual({ email: null, error: null });
    expect(normalizeEmail("kaputt").error).toMatch(/gültig/);
    expect(normalizeEmail("x@schulos.local").error).toMatch(/reserviert/);
  });

  it("Selbstbedienung: Link an die neue Adresse, Adresse erst nach Bestätigung übernommen und bestätigt", async () => {
    const before = await userRow(JANA);
    expect(before.emailVerified).toBe(false);
    const r = await requestEmailChange(h.db, JANA, "Jana.Brandt@Example.org", opts);
    expect(r.sentTo).toBe("jana.brandt@example.org");
    expect((await userRow(JANA)).email).toBe(before.email);
    const [mail] = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "email-bestaetigen"));
    expect(mail).toMatchObject({ to: "jana.brandt@example.org", subject: "Lindenhof: E-Mail-Adresse bestätigen" });
    expect(mail!.text).toContain(r.link!);
    // nur der Hash steht in der DB
    const [v] = await h.db.select().from(verifications).where(eq(verifications.identifier, `email-change:${JANA}`));
    expect(v!.value).not.toContain(tokenOf(r.link));

    const token = tokenOf(r.link);
    // anderes Konto, falscher Token, abgelaufen → ungültig
    expect(await pendingEmailChange(h.db, LEA, token)).toBeNull();
    expect(await pendingEmailChange(h.db, JANA, `${token}x`)).toBeNull();
    expect(await pendingEmailChange(h.db, JANA, token, new Date(Date.now() + 25 * 3_600_000))).toBeNull();
    await expect(confirmEmailChange(h.db, LEA, token, opts)).rejects.toBeInstanceOf(EmailChangeError);

    expect(await confirmEmailChange(h.db, JANA, token, opts)).toBe("jana.brandt@example.org");
    expect(await userRow(JANA)).toMatchObject({ email: "jana.brandt@example.org", emailVerified: true });
    // Link nur einmal
    await expect(confirmEmailChange(h.db, JANA, token, opts)).rejects.toThrow(/ungültig oder abgelaufen/);
    const logged = await h.db.select().from(auditLog).where(and(eq(auditLog.target, JANA), like(auditLog.action, "konto.email.%")));
    expect(logged.map((l) => l.action).sort()).toEqual(["konto.email.angefordert", "konto.email.bestaetigt"]);
    expect(JSON.stringify(logged)).not.toContain("example.org");
  });

  it("neuer Link macht den alten ungültig; Wechsel meldet sich an der alten Adresse", async () => {
    const first = await requestEmailChange(h.db, JANA, "erst@example.org", opts);
    const second = await requestEmailChange(h.db, JANA, "neu@example.org", opts);
    expect(await pendingEmailChange(h.db, JANA, tokenOf(first.link))).toBeNull();
    await confirmEmailChange(h.db, JANA, tokenOf(second.link), opts);
    const notices = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "email-geaendert"));
    expect(notices.map((n) => n.to)).toEqual(["jana.brandt@example.org"]);
  });

  it("Adresse eines anderen Kontos: gleiche Antwort, aber keine Mail (kein Aufzählen)", async () => {
    const n = (await h.db.select().from(mailOutbox)).length;
    const r = await requestEmailChange(h.db, "u-petra.lindner", "NEU@example.org", opts);
    expect(r).toEqual({ sentTo: "neu@example.org", link: null });
    expect((await h.db.select().from(mailOutbox)).length).toBe(n);
  });

  it("Rate-Limit (P4-31): höchstens 3 Links je Stunde und Konto", async () => {
    // Jana hat in den Tests oben schon drei Links angefordert
    await expect(requestEmailChange(h.db, JANA, "vierte@example.org", opts)).rejects.toThrow(/Zu viele Anfragen/);
    const later = new Date(Date.now() + 2 * 3_600_000);
    expect((await requestEmailChange(h.db, JANA, "vierte@example.org", { ...opts, now: later })).link).not.toBeNull();
  });

  it("Schüler:innen: keine Selbstbedienung; entfernen setzt den Platzhalter zurück", async () => {
    await expect(requestEmailChange(h.db, LEA, "lea@example.org", opts)).rejects.toThrow(/Sekretariat/);
    await expect(removeOwnEmail(h.db, LEA)).rejects.toThrow(/Sekretariat/);
    await removeOwnEmail(h.db, JANA);
    expect(await userRow(JANA)).toMatchObject({ email: "jana.brandt@schulos.local", emailVerified: false });
  });

  it("Verwaltung: Adresse beim Anlegen/Bearbeiten optional, eindeutig, geänderte Adresse ist unbestätigt", async () => {
    const res = await createUser(h.db, ADMIN, { firstName: "Mia", lastName: "Mail", role: "eltern", email: "Mia@Example.org" });
    expect(await userRow(res.id)).toMatchObject({ email: "mia@example.org", emailVerified: false });
    const dup = createUser(h.db, ADMIN, { firstName: "Max", lastName: "Mail", role: "eltern", email: "mia@example.org" });
    await expect(dup).rejects.toBeInstanceOf(ValidationError);
    await expect(createUser(h.db, ADMIN, { firstName: "A", lastName: "B", role: "eltern", email: "kaputt" })).rejects.toMatchObject({
      fieldErrors: { email: expect.stringMatching(/gültig/) },
    });
    const plain = await createUser(h.db, ADMIN, { firstName: "Ohne", lastName: "Mail", role: "schueler" });
    expect((await userRow(plain.id)).email).toBe(`${plain.username}@schulos.local`);

    // bestätigte Adresse bleibt bestätigt, solange die Verwaltung sie nicht ändert
    await h.db.update(users).set({ emailVerified: true }).where(eq(users.id, res.id));
    const base = { firstName: "Mia", lastName: "Mail", role: "eltern" as const };
    await updateUser(h.db, ADMIN, res.id, { ...base, email: "mia@example.org" });
    expect((await userRow(res.id)).emailVerified).toBe(true);
    await updateUser(h.db, ADMIN, res.id, { ...base });
    expect((await userRow(res.id)).email).toBe("mia@example.org");
    await updateUser(h.db, ADMIN, res.id, { ...base, email: "mia2@example.org" });
    expect(await userRow(res.id)).toMatchObject({ email: "mia2@example.org", emailVerified: false });
    await updateUser(h.db, ADMIN, res.id, { ...base, email: "" });
    expect((await userRow(res.id)).email).toBe(`${res.username}@schulos.local`);
  });

  it("Import: Spalte E-Mail optional (mit Kopfzeile), geprüft und eindeutig", async () => {
    const csv = "Vorname;Nachname;Klasse;E-Mail\nEmil;Eins;5a;emil@example.org\nErna;Zwei;5a;\nEva;Drei;5a;emil@example.org\nEdo;Vier;5a;kaputt";
    const parsed = parseStudentCsv(csv);
    expect(parsed.rows.map((r) => r.email)).toEqual(["emil@example.org", undefined, "emil@example.org", "kaputt"]);
    const plan = await planImport(h.db, parsed.rows);
    expect(plan.map((p) => p.error ?? null)).toEqual([null, null, "E-Mail „emil@example.org“ hat schon ein Konto", "E-Mail: Keine gültige E-Mail-Adresse"]);
    const res = await executeImport(h.db, ADMIN, plan);
    expect(res.created).toHaveLength(2);
    const emil = await userRow(`u-${res.created[0]!.username}`);
    expect(emil).toMatchObject({ email: "emil@example.org", emailVerified: false });
    expect((await userRow(`u-${res.created[1]!.username}`)).email).toMatch(/@schulos\.local$/);
  });

  it("Q5-24: Verwaltung sendet den Bestätigungslink an die eingetragene, unbestätigte Adresse (nur mit SMTP, Rate-Limit, Audit, SEC-04)", async () => {
    const on = { school: "Lindenhof", mailOn: true };
    const res = await createUser(h.db, ADMIN, { firstName: "Bea", lastName: "Link", role: "eltern", email: "bea@example.org" });
    const plain = await createUser(h.db, ADMIN, { firstName: "Ohne", lastName: "Adresse", role: "eltern" });
    await expect(sendEmailConfirmation(h.db, ADMIN, res.id, { school: "L", mailOn: false })).rejects.toMatchObject({ fieldErrors: { email: /nicht eingerichtet/ } });
    await expect(sendEmailConfirmation(h.db, ADMIN, plain.id, on)).rejects.toMatchObject({ fieldErrors: { email: /keine E-Mail-Adresse/ } });
    // SEC-04: das Sekretariat verwaltet kein Admin-Konto
    await expect(sendEmailConfirmation(h.db, "u-sabine.kowalski", ADMIN, on)).rejects.toBeInstanceOf(ValidationError);
    // Liste: unbestätigt
    const listed = async () => (await listUsers(h.db, { q: "Link" })).rows.find((r) => r.id === res.id)!;
    expect(await listed()).toMatchObject({ hasEmail: true, emailVerified: false });
    expect(JSON.stringify(await listed())).not.toContain("bea@example.org");
    expect((await listUsers(h.db, { q: "Adresse" })).rows.find((r) => r.id === plain.id)).toMatchObject({ hasEmail: false });

    expect(await sendEmailConfirmation(h.db, "u-sabine.kowalski", res.id, on)).toBe("bea@example.org");
    const [mail] = await h.db.select().from(mailOutbox).where(and(eq(mailOutbox.to, "bea@example.org"), eq(mailOutbox.purpose, "email-bestaetigen")));
    expect(mail!.text).toContain("Ihre Schule hat in SchulOS diese E-Mail-Adresse");
    const token = mail!.text.match(/\/konto\/email\/([\w-]+)/)![1]!;
    // bestätigen kann nur die Person selbst (angemeldet)
    expect(await pendingEmailChange(h.db, ADMIN, token)).toBeNull();
    expect(await confirmEmailChange(h.db, res.id, token, opts)).toBe("bea@example.org");
    expect(await listed()).toMatchObject({ hasEmail: true, emailVerified: true });
    await expect(sendEmailConfirmation(h.db, ADMIN, res.id, on)).rejects.toMatchObject({ fieldErrors: { email: /schon bestätigt/ } });
    const logged = await h.db.select().from(auditLog).where(and(eq(auditLog.target, res.id), eq(auditLog.action, "verwaltung.user.email_link")));
    expect(logged).toEqual([expect.objectContaining({ actorId: "u-sabine.kowalski" })]);
    expect(JSON.stringify(logged)).not.toContain("example.org");

    // Rate-Limit: höchstens 3 Links je Konto und Tag
    const other = await createUser(h.db, ADMIN, { firstName: "Rita", lastName: "Rate", role: "eltern", email: "rita@example.org" });
    for (let i = 0; i < 3; i++) await sendEmailConfirmation(h.db, ADMIN, other.id, on);
    await expect(sendEmailConfirmation(h.db, ADMIN, other.id, on)).rejects.toMatchObject({ fieldErrors: { email: /Zu viele Anfragen/ } });
    // nur der letzte Link gilt
    expect(await h.db.select().from(verifications).where(eq(verifications.identifier, `email-change:${other.id}`))).toHaveLength(1);
  });
});
