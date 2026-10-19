// Schulbücherei – Erinnerung und Mahnstufen (BU-04, SICHERHEIT S76): Erinnerung vor Fristende, Mahnstufen 1–3 nur an Schultagen
// mit Abstand, Eltern Minderjähriger ab Stufe 2 (nicht bei Eigenständigen), Benachrichtigungen und Mails ohne Titel, Mahnstufe
// lebt nur mit der offenen Ausleihe, Mahnliste fürs Team (Schüler-Helfer:innen ohne Mahnstufen), nur Zähler bleiben.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiCopies, buechereiLoans, buechereiStats, groupMembers, mailOutbox, notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays, weekdayMon0 } from "@/core/time";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { libraryAuskunft, libraryText, myLibrary } from "./katalog";
import { checkin, checkout, deskPerson, renewLoan } from "./loans";
import { dunningList, dunningMail, nextDunningLevel, runDunning } from "./mahnungen";
import { createTitle } from "./service";
import { dueDate } from "./dates";
import { DUNNING_MAIL, REMIND_DAYS } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: Theke
const JANA = "u-jana.brandt"; // Lehrkraft, kein Büchereiteam
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const OPTS = { mail: true, school: "Testschule" };
const TITLE = "Mahnprobe Geheimtitel";

describe("Bücherei – Erinnerung und Mahnstufen", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let copies: string[];
  let day: string; // ein Schultag
  let helper: string; // Schüler-Helfer:in im Büchereiteam

  const loanOf = async (barcode: string) => {
    const [c] = await h.db.select({ id: buechereiCopies.id }).from(buechereiCopies).where(eq(buechereiCopies.barcode, barcode));
    const [l] = await h.db.select().from(buechereiLoans).where(eq(buechereiLoans.copyId, c!.id));
    return l;
  };
  const setDue = async (barcode: string, dueOn: string) => {
    const l = await loanOf(barcode);
    await h.db.update(buechereiLoans).set({ dueOn }).where(eq(buechereiLoans.id, l!.id));
  };
  const gong = async (userId: string, key: string) => {
    const [n] = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, key)));
    return n ?? null;
  };
  /** nächster Schultag ab `ymd` */
  const school = (ymd: string) => dueDate(h.db, ymd, 0);

  beforeAll(async () => {
    h = await createSeededTestDb();
    const { barcodes } = await createTitle(h.db, await p(SABINE), { title: TITLE, mediaType: "buch" }, { count: 3 });
    copies = barcodes;
    day = await school("2026-11-09");
    const [m] = await h.db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-buecherei"), eq(groupMembers.role, "member")));
    helper = m!.userId;
    // Demo-Ausleihen aus dem Weg räumen, damit nur die eigenen zählen
    await h.db.update(buechereiLoans).set({ userId: null });
  });
  afterAll(async () => {
    await h.close();
  });

  it("rein: Stufe 1 sobald überfällig, weitere nach dem Abstand, höchstens 3", () => {
    const T = "2026-11-10";
    expect(nextDunningLevel({ dueOn: T, dunningLevel: 0, dunnedOn: null }, T, 7)).toBeNull();
    expect(nextDunningLevel({ dueOn: "2026-11-09", dunningLevel: 0, dunnedOn: null }, T, 7)).toBe(1);
    expect(nextDunningLevel({ dueOn: "2026-11-01", dunningLevel: 1, dunnedOn: "2026-11-04" }, T, 7)).toBeNull();
    expect(nextDunningLevel({ dueOn: "2026-11-01", dunningLevel: 1, dunnedOn: "2026-11-03" }, T, 7)).toBe(2);
    expect(nextDunningLevel({ dueOn: "2026-10-01", dunningLevel: 3, dunnedOn: "2026-10-20" }, T, 7)).toBeNull();
    const mail = dunningMail({ school: "S", level: 2, count: 1, since: "2026-11-02", link: "https://x/buecherei/meine", child: "Lea" });
    expect(mail.subject).toBe("S: 2. Mahnung der Schulbücherei");
    expect(mail.text).toContain("eine Ausleihe von Lea");
  });

  it("Job `buecherei-mahnungen` steht im Zeitplan", () => {
    expect(SCHEDULED_JOBS.find((j) => j.name === "buecherei-mahnungen")).toMatchObject({ at: "06:45", until: "20:00" });
  });

  it("Erinnerung vor Fristende: einmal je Fälligkeit, ohne Titel; Verlängern erinnert neu", async () => {
    const desk = await p(SABINE);
    await checkout(h.db, desk, LEA, copies[0]!, day);
    await setDue(copies[0]!, addDays(day, 2));
    expect((await runDunning(h.db, day, OPTS)).reminded).toBe(1);
    const n = await gong(LEA, "buecherei:erinnerung");
    expect(n).toMatchObject({ title: "Bücherei: Rückgabe bald fällig", href: "/buecherei/meine" });
    expect(`${n!.title} ${n!.body}`).not.toContain(TITLE);
    // zweiter Lauf: schon erinnert
    expect((await runDunning(h.db, day, OPTS)).reminded).toBe(0);
    // weiter weg als eingestellt → (noch) nicht
    await writeModuleSetting(h.db, REMIND_DAYS, "1");
    await checkout(h.db, desk, JANA, copies[1]!, day);
    await setDue(copies[1]!, addDays(day, 2));
    expect((await runDunning(h.db, day, OPTS)).reminded).toBe(0);
    await writeModuleSetting(h.db, REMIND_DAYS, "0");
    expect((await runDunning(h.db, addDays(day, 1), OPTS)).reminded).toBe(0);
    await writeModuleSetting(h.db, REMIND_DAYS, "2");
    // Verlängern → neue Fälligkeit, neue Erinnerung möglich
    const l = await loanOf(copies[0]!);
    expect(l!.remindedDueOn).toBe(addDays(day, 2));
    await renewLoan(h.db, desk, l!.id, day);
    expect((await loanOf(copies[0]!))!.remindedDueOn).toBeNull();
    // aufräumen: beide zurück
    await checkin(h.db, desk, copies[0]!, day);
    await checkin(h.db, desk, copies[1]!, day);
  });

  it("Mahnstufen 1–3 nur an Schultagen mit Abstand; Eltern Minderjähriger ab Stufe 2; alles ohne Titel; Mail optional", async () => {
    const desk = await p(SABINE);
    await h.db.update(users).set({ email: "lea@example.org", emailVerified: true }).where(eq(users.id, LEA));
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, MUTTER));
    await checkout(h.db, desk, LEA, copies[0]!, day);
    await checkout(h.db, desk, JANA, copies[1]!, day);
    await setDue(copies[0]!, addDays(day, -1));
    await setDue(copies[1]!, addDays(day, -1));

    // Wochenende/Ferien: keine Mahnung
    let closed = addDays(day, 1);
    while (weekdayMon0(closed) < 5) closed = addDays(closed, 1);
    expect((await runDunning(h.db, closed, OPTS)).dunned).toBe(0);
    expect((await loanOf(copies[0]!))!.dunningLevel).toBe(0);

    // Stufe 1: nur die Person, keine Mail (Vorgabe aus)
    expect(await runDunning(h.db, day, OPTS)).toMatchObject({ dunned: 2, parents: 0 });
    expect(await loanOf(copies[0]!)).toMatchObject({ dunningLevel: 1, dunnedOn: day });
    const g1 = await gong(LEA, "buecherei:mahnung");
    expect(g1).toMatchObject({ title: "1. Mahnung der Bücherei", href: "/buecherei/meine" });
    expect(g1!.body).not.toContain(TITLE);
    expect(g1!.body).not.toContain("Eltern");
    expect(await gong(MUTTER, `buecherei:mahnung:${LEA}`)).toBeNull();
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "buecherei-mahnung"))).toEqual([]);
    // gleicher Tag noch einmal: nichts
    expect((await runDunning(h.db, day, OPTS)).dunned).toBe(0);
    // vor Ablauf des Abstands: nichts
    expect((await runDunning(h.db, await school(addDays(day, 3)), OPTS)).dunned).toBe(0);

    // Stufe 2 mit Mail: Person + Eltern (Lea), Lehrkraft ohne Eltern
    await writeModuleSetting(h.db, DUNNING_MAIL, "1");
    const d2 = await school(addDays(day, 7));
    expect(await runDunning(h.db, d2, OPTS)).toMatchObject({ dunned: 2 });
    expect((await loanOf(copies[0]!))!.dunningLevel).toBe(2);
    expect((await gong(LEA, "buecherei:mahnung"))!.body).toContain("Deine Eltern werden ebenfalls benachrichtigt");
    expect((await gong(JANA, "buecherei:mahnung"))!.body).not.toContain("Eltern");
    const parent = await gong(MUTTER, `buecherei:mahnung:${LEA}`);
    expect(parent).toMatchObject({ title: "2. Mahnung der Bücherei für Lea", href: "/buecherei/meine" });
    expect(parent!.body).not.toContain(TITLE);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "buecherei-mahnung"));
    expect(mails.map((m) => m.to).sort()).toEqual(["lea@example.org", "mutter@example.org"]);
    for (const m of mails) {
      expect(`${m.subject} ${m.text}`).not.toContain(TITLE);
      expect(m.text).toContain("/buecherei/meine");
    }
    await h.db.delete(mailOutbox);

    // Stufe 3: eigenständig gewordene Schülerin → Eltern erfahren nichts mehr
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, LEA));
    const d3 = await school(addDays(d2, 7));
    // ohne eingerichteten Mailversand (mail: false) keine Mail, auch wenn eingeschaltet
    expect(await runDunning(h.db, d3, { ...OPTS, mail: false })).toMatchObject({ dunned: 2, parents: 0 });
    expect((await gong(MUTTER, `buecherei:mahnung:${LEA}`))!.title).toBe("2. Mahnung der Bücherei für Lea");
    expect(await h.db.select().from(mailOutbox)).toEqual([]);
    await h.db.update(users).set({ selfResponsible: false }).where(eq(users.id, LEA));
    // mehr als Stufe 3 gibt es nicht
    expect((await runDunning(h.db, await school(addDays(d3, 30)), OPTS)).dunned).toBe(0);
    expect((await loanOf(copies[0]!))!.dunningLevel).toBe(3);
    await writeModuleSetting(h.db, DUNNING_MAIL, "0");

    // nur gezählt: 6 Mahnungen im Monat (ohne Person)
    const stats = await h.db.select().from(buechereiStats).where(and(inArray(buechereiStats.month, [day.slice(0, 7), d2.slice(0, 7), d3.slice(0, 7)]), eq(buechereiStats.mediaType, "buch")));
    expect(stats.reduce((s, r) => s + r.dunnings, 0)).toBe(6);
    expect(Object.keys(stats[0]!)).not.toContain("userId");
  });

  it("S76: Mahnstufe sieht die Person (und Auskunft), die Theke nicht; Mahnliste ohne Stufen für Schüler-Helfer:innen", async () => {
    const today = await school(addDays(day, 40));
    // Person selbst
    const lib = await myLibrary(h.db, await p(LEA), today);
    expect(lib.loans[0]).toMatchObject({ overdue: true, dunningLevel: 3 });
    expect(libraryText(await libraryAuskunft(h.db, LEA))).toContain("3. Mahnung");
    // Theke: keine Mahnstufe
    const person = await deskPerson(h.db, await p(SABINE), LEA, today);
    expect(person!.loans[0]).not.toHaveProperty("dunningLevel");
    // Mahnliste: Erwachsene mit Stufe, Schüler-Helfer:in ohne, ohne Thekenrecht gar nicht
    const adult = await dunningList(h.db, await p(SABINE), today);
    expect(adult.find((r) => r.userId === LEA)).toMatchObject({ title: TITLE, className: "7b", dunningLevel: 3, dunnedOn: expect.any(String) });
    const pupil = await dunningList(h.db, await p(helper), today);
    expect(pupil.find((r) => r.userId === LEA)).toMatchObject({ title: TITLE, dunningLevel: null, dunnedOn: null });
    expect(JSON.stringify(pupil)).not.toMatch(/"dunningLevel":\d/);
    await expect(dunningList(h.db, await p(JANA), today)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dunningList(h.db, await p(MUTTER), today)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Mahnstufe endet mit der Ausleihe: Verlängern setzt zurück, Rückgabe löscht, Befund behält keine Stufe", async () => {
    const desk = await p(SABINE);
    const today = await school(addDays(day, 40));
    await writeModuleSetting(h.db, (await import("./settings")).MAX_RENEWALS, "5");
    const jana = await loanOf(copies[1]!);
    await renewLoan(h.db, desk, jana!.id, today);
    expect(await loanOf(copies[1]!)).toMatchObject({ dunningLevel: 0, dunnedOn: null });
    await checkin(h.db, desk, copies[1]!, today);
    expect(await loanOf(copies[1]!)).toBeUndefined();
    await checkin(h.db, desk, copies[0]!, today, "Seite fehlt");
    expect(await loanOf(copies[0]!)).toMatchObject({ finding: "Seite fehlt", dunningLevel: 0, dunnedOn: null, remindedDueOn: null });
    expect((await dunningList(h.db, desk, today)).filter((r) => r.title === TITLE)).toEqual([]);
  });
});
