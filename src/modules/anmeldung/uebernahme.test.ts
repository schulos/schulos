import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import type { DbHandle } from "@/core/db/client";
import { accounts, anmeldungAntraege, auditLog, groupMembers, groups, parentChild, schoolYears, schoolYearTransitions, sessions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { nextStep, promote, startTransition } from "@/modules/verwaltung/schuljahreswechsel";
import { decide } from "./entscheidung";
import { addSlots, createVerfahren, insertAntrag, publishVerfahren } from "./service";
import {
  admissionCredentialsCsv,
  admitStudents,
  pendingAdmissions,
  proposeAssignment,
  proposeClassNames,
  regenerateAdmissionPasswords,
  SKIP,
  splitParentName,
} from "./uebernahme";

describe("Übernahme Neuaufnahmen (rein)", () => {
  it("Klassennamen nach Richtwert, Familien bleiben zusammen, sonst gleichmäßig", () => {
    expect(proposeClassNames("5", 1)).toEqual(["5a"]);
    expect(proposeClassNames("5", 70)).toEqual(["5a", "5b", "5c"]);
    const c = (id: string, mail: string) => ({ antragId: id, parent1Email: mail });
    const r = proposeAssignment([c("1", "a@x"), c("2", "a@x"), c("3", "b@x"), c("4", "c@x"), c("5", "d@x")], ["5a", "5b"]);
    expect(r["1"]).toBe(r["2"]);
    expect(Object.values(r).filter((x) => x === "5a")).toHaveLength(3);
    expect(Object.values(r).filter((x) => x === "5b")).toHaveLength(2);
    expect(proposeAssignment([c("1", "a@x")], [])).toEqual({});
  });

  it("Name des Elternteils teilen", () => {
    expect(splitParentName("Andrea Maria Beispiel", "X")).toEqual({ firstName: "Andrea Maria", lastName: "Beispiel" });
    expect(splitParentName(" Kowalski ", "Nowak")).toEqual({ firstName: "Kowalski", lastName: "Nowak" });
  });

  it("nextStep: Neuaufnahmen nach der Versetzung, nur wenn welche offen sind", () => {
    const d = new Date();
    const t = { promotedAt: d, archivedAt: null, reviewedAt: null, completedAt: null, admittedAt: null };
    expect(nextStep(t, 0, 3)).toBe("admissions");
    expect(nextStep({ ...t, promotedAt: null }, 0, 3)).toBe("promote");
    expect(nextStep(t, 0, 0)).toBe("archive_groups");
    expect(nextStep({ ...t, admittedAt: d }, 2, 3)).toBe("archive_export");
  });
});

describe("Übernahme Neuaufnahmen im Schuljahreswechsel (P4-39)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let vid: string;
  let tid: string;
  const ids: Record<string, string> = {};
  const now = new Date("2027-06-20T10:00:00Z");
  let familyParent: { id: string; email: string };

  const add = async (first: string, last: string, email: string, parentUserId: string | null = null) => {
    const r = await insertAntrag(
      h.db,
      vid,
      {
        childFirstName: first,
        childLastName: last,
        childBirthDate: "2016-04-03",
        primarySchool: first === "Ida" ? "GS Nord" : "GS Süd",
        parent1Name: `Andrea ${last}`,
        parent1Email: email,
        addressStreet: "Weg 1",
        addressZip: "45127",
        addressCity: "Essen",
      },
      { status: "eingegangen", now: new Date("2027-02-05T10:00:00Z"), parentUserId },
    );
    ids[first] = r.id;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    vid = await createVerfahren(h.db, sabine, { name: "Klasse 5 – 2027/28", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, new Date("2027-01-31T10:00:00Z"));
    // vorhandenes Elternkonto (Geschwisterkind an der Schule) – einmal über das Konto, einmal nur gleiche E-Mail
    const [p] = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern")).limit(1);
    await h.db.update(users).set({ email: "familie.konto@example.org", emailVerified: true }).where(eq(users.id, p!.id));
    familyParent = { id: p!.id, email: "familie.konto@example.org" };
    await add("Ida", "Imhof", "imhof@example.org");
    await add("Max", "Zwilling", "zwilling@example.org");
    await add("Moritz", "Zwilling", "ZWILLING@example.org");
    await add("Kai", "Konto", "anders@example.org", p!.id);
    await add("Ella", "Mail", "familie.konto@example.org");
    await add("Nora", "Nicht", "nicht@example.org");
    await add("Wanda", "Warte", "warte@example.org");
    await decide(h.db, petra, vid, ["Ida", "Max", "Moritz", "Kai", "Ella", "Nora"].map((n) => ids[n]!), "aufgenommen", { school: "L", now });
    await decide(h.db, petra, vid, [ids.Wanda!], "warteliste", { school: "L", now });
    tid = await startTransition(h.db, "u-admin", cur!.id, "sj-2027-28");
  });
  afterAll(async () => h?.close());

  it("Kandidaten: nur Aufgenommene des Zieljahres, vorhandene Elternkonten erkannt (Konto bzw. gleiche E-Mail)", async () => {
    const list = await pendingAdmissions(h.db, "sj-2027-28");
    expect(list.map((c) => c.childFirstName).sort()).toEqual(["Ella", "Ida", "Kai", "Max", "Moritz", "Nora"]);
    expect(list.find((c) => c.childFirstName === "Kai")!.existingParent).toMatchObject({ id: familyParent.id, via: "konto" });
    expect(list.find((c) => c.childFirstName === "Ella")!.existingParent).toMatchObject({ id: familyParent.id, via: "email" });
    expect(list.find((c) => c.childFirstName === "Moritz")).toMatchObject({ parent1Email: "zwilling@example.org", existingParent: null });
    // GATE-4c: per E-Mail nur mit bestätigter Adresse (Tippfehler der Verwaltung verknüpft sonst eine fremde Familie)
    await h.db.update(users).set({ emailVerified: false }).where(eq(users.id, familyParent.id));
    const unverified = await pendingAdmissions(h.db, "sj-2027-28");
    expect(unverified.find((c) => c.childFirstName === "Ella")!.existingParent).toBeNull();
    // Q5-20: stattdessen als Vorschlag zum Ankreuzen
    expect(unverified.find((c) => c.childFirstName === "Ella")!.suggestedParent).toMatchObject({ id: familyParent.id });
    expect(list.find((c) => c.childFirstName === "Ella")!.suggestedParent).toBeNull();
    expect(unverified.find((c) => c.childFirstName === "Kai")!.existingParent).toMatchObject({ via: "konto" });
    await h.db.update(users).set({ emailVerified: true }).where(eq(users.id, familyParent.id));
    expect(await pendingAdmissions(h.db, "anderes-jahr")).toEqual([]);
  });

  it("erst nach der Versetzung; Klassen müssen in der Liste stehen", async () => {
    const assign = { [ids.Ida!]: "5a" };
    await expect(admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign }, now)).rejects.toMatchObject({ fieldErrors: { transition: /Versetzung/ } });
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const [t] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(nextStep(t!, 0, 6)).toBe("admissions");
    await expect(admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: { [ids.Ida!]: "5z" } }, now)).rejects.toMatchObject({
      fieldErrors: { [`assign-${ids.Ida}`]: /5z/ },
    });
    await expect(admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: {} }, now)).rejects.toMatchObject({ fieldErrors: { assign: expect.any(String) } });
  });

  it("übernehmen: Klassen im neuen Jahr, Konten Kind + Elternteil, Zwillinge ein Elternkonto, vorhandene verknüpft, Anträge übernommen", async () => {
    const assign: Record<string, string> = { [ids.Ida!]: "5a", [ids.Max!]: "5b", [ids.Moritz!]: "5b", [ids.Kai!]: "5a", [ids.Ella!]: "5b", [ids.Nora!]: SKIP };
    const r = await admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a", "5b", "5c"] }, assign }, now);
    expect(r).toMatchObject({ classes: 2, students: 5, parentsCreated: 2, parentsLinked: 1, skipped: 1 });
    // neue Klassen nur im neuen Schuljahr; der alte Kurzname „5a“ bekam das Schuljahr angehängt
    const fiveA = await h.db.select().from(groups).where(eq(groups.slug, "5a"));
    expect(fiveA).toEqual([expect.objectContaining({ name: "Klasse 5a", schoolYearId: "sj-2027-28", gradeLevel: 5, kind: "klasse" })]);
    expect(await h.db.select().from(groups).where(eq(groups.slug, "5c"))).toEqual([]);
    const members = await h.db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, fiveA[0]!.id));
    expect(members).toHaveLength(2);

    const ida = r.credentials.find((c) => c.name === "Ida Imhof")!;
    expect(ida).toMatchObject({ art: "Schüler:in", klasse: "5a", username: "ida.imhof" });
    const [idaUser] = await h.db.select().from(users).where(eq(users.username, "ida.imhof"));
    expect(idaUser).toMatchObject({ role: "schueler", mustChangePassword: true, emailVerified: false });
    const [acc] = await h.db.select().from(accounts).where(eq(accounts.userId, idaUser!.id));
    expect(await verifyPassword({ hash: acc!.password!, password: ida.password })).toBe(true);

    // Zwillinge: ein neues Elternkonto mit beiden Kindern, E-Mail übernommen (unbestätigt)
    const zw = r.credentials.find((c) => c.art === "Elternteil" && c.kind.includes("Max"))!;
    expect(zw).toMatchObject({ name: "Andrea Zwilling", klasse: "5b", kind: "Max Zwilling, Moritz Zwilling" });
    expect(zw.password).not.toBe("");
    const [zwUser] = await h.db.select().from(users).where(eq(users.username, zw.username));
    expect(zwUser).toMatchObject({ role: "eltern", email: "zwilling@example.org", emailVerified: false });
    expect(await h.db.select().from(parentChild).where(eq(parentChild.parentId, zwUser!.id))).toHaveLength(2);

    // vorhandenes Elternkonto: Kai (über das Konto) und Ella (gleiche E-Mail) – kein neues Passwort
    const fam = r.credentials.find((c) => c.art === "Elternteil" && c.kind.includes("Kai"))!;
    expect(fam).toMatchObject({ password: "", kind: "Ella Mail, Kai Konto" });
    const famKids = await h.db.select().from(parentChild).where(eq(parentChild.parentId, familyParent.id));
    expect(famKids.map((k) => k.childId)).toEqual(expect.arrayContaining(r.credentials.filter((c) => ["Kai Konto", "Ella Mail"].includes(c.name)).map((c) => `u-${c.username}`)));

    const [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Ida!));
    expect(a).toMatchObject({ status: "uebernommen", transferredUserId: idaUser!.id, transferredAt: now, retentionFrom: now });
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Nora!)))[0]!.status).toBe("aufgenommen");
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Wanda!)))[0]!.status).toBe("warteliste");

    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schuljahreswechsel.neuaufnahmen"));
    expect(log!.meta).toMatchObject({ klassen: 2, schueler: 5, eltern_neu: 2, eltern_verknuepft: 1, nicht_uebernommen: 1 });
    expect(JSON.stringify(log)).not.toMatch(/Imhof|Zwilling/);

    // nur einmal je Durchlauf; danach geht der Assistent weiter
    await expect(admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: { [ids.Nora!]: "5a" } }, now)).rejects.toMatchObject({ fieldErrors: { transition: /bereits/ } });
    await expect(admitStudents(h.db, "u-admin", tid, { classes: {}, assign: {}, skipAll: true }, now)).rejects.toMatchObject({ fieldErrors: { transition: /bereits/ } });
    const [t] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(nextStep(t!, 0, 1)).toBe("archive_groups");
    // Q5-21: gemerkt werden nur die neu angelegten Konten (5 Kinder + 2 neue Elternkonten), nicht das verknüpfte
    expect(t!.admittedUsers).toHaveLength(7);
    expect(t!.admittedUsers).not.toContain(familyParent.id);

    const csv = admissionCredentialsCsv(r.credentials);
    expect(csv.split("\r\n")[0]).toBe("﻿Art;Name;Klasse;Benutzername;Startpasswort;Kind");
    expect(csv).toContain("Zugang besteht");
    expect(await h.db.select().from(users).where(and(eq(users.role, "schueler"), eq(users.username, "nora.nicht")))).toEqual([]);
  });
});

describe("Neuaufnahmen: niemanden übernehmen (GATE-4c, Code-M4)", () => {
  let h: DbHandle;
  afterAll(async () => h?.close());

  it("alle Zusagen zurückgenommen → Schritt ohne Konten abschließen, Assistent geht weiter", async () => {
    h = await createSeededTestDb();
    const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    const petra = await loadPermissions(h.db, "u-petra.lindner");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    const a = await insertAntrag(
      h.db,
      vid,
      { childFirstName: "Paul", childLastName: "Absage", childBirthDate: "2016-04-03", primarySchool: "GS", parent1Name: "Pia Absage", parent1Email: "absage@example.org", addressStreet: "Weg 1", addressZip: "45127", addressCity: "Essen" },
      { status: "eingegangen", now: new Date("2027-02-05T10:00:00Z") },
    );
    await decide(h.db, petra, vid, [a.id], "aufgenommen", { school: "L", now: new Date("2027-03-01T10:00:00Z") });
    const tid = await startTransition(h.db, "u-admin", cur!.id, "sj-2027-28");
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const now = new Date("2027-07-01T10:00:00Z");
    // ohne Haken: Hinweis auf „Niemanden übernehmen“
    await expect(admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: { [a.id]: SKIP } }, now)).rejects.toMatchObject({ fieldErrors: { assign: /Niemanden übernehmen/ } });
    const r = await admitStudents(h.db, "u-admin", tid, { classes: {}, assign: {}, skipAll: true }, now);
    expect(r).toEqual({ classes: 0, students: 0, parentsCreated: 0, parentsLinked: 0, parentsSuggestedLinked: 0, skipped: 1, credentials: [] });
    const [t] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(t!.admittedAt).toEqual(now);
    expect(nextStep(t!, 0, 1)).toBe("archive_groups");
    expect(await h.db.select().from(users).where(eq(users.email, "absage@example.org"))).toEqual([]);
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, a.id)))[0]!.status).toBe("aufgenommen");
  }, 60_000);
});

describe("Neuaufnahmen: unbestätigte Elternkonto-Treffer als Vorschlag (Q5-20)", () => {
  let h: DbHandle;
  afterAll(async () => h?.close());

  it("Vorschlag nur mit Haken verknüpft; ohne Haken neues Elternkonto; fremde Antrags-IDs wirkungslos", async () => {
    h = await createSeededTestDb();
    const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    const petra = await loadPermissions(h.db, "u-petra.lindner");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    // zwei vorhandene Elternkonten mit eingetragener, aber unbestätigter Adresse
    const parents = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern")).limit(2);
    const [pa, pb] = parents as [{ id: string }, { id: string }];
    await h.db.update(users).set({ email: "ja@example.org", emailVerified: false }).where(eq(users.id, pa.id));
    await h.db.update(users).set({ email: "nein@example.org", emailVerified: false }).where(eq(users.id, pb.id));
    const add = async (first: string, email: string) =>
      (
        await insertAntrag(
          h.db,
          vid,
          { childFirstName: first, childLastName: "Vorschlag", childBirthDate: "2016-04-03", primarySchool: "GS", parent1Name: `Eltern ${first}`, parent1Email: email, addressStreet: "Weg 1", addressZip: "45127", addressCity: "Essen" },
          { status: "eingegangen", now: new Date("2027-02-05T10:00:00Z") },
        )
      ).id;
    const ja = await add("Jan", "ja@example.org");
    const nein = await add("Nils", "nein@example.org");
    const ohne = await add("Olga", "ohne@example.org");
    await decide(h.db, petra, vid, [ja, nein, ohne], "aufgenommen", { school: "L", now: new Date("2027-03-01T10:00:00Z") });
    const list = await pendingAdmissions(h.db, "sj-2027-28");
    expect(list.find((c) => c.antragId === ja)).toMatchObject({ existingParent: null, suggestedParent: { id: pa.id } });
    expect(list.find((c) => c.antragId === ohne)).toMatchObject({ existingParent: null, suggestedParent: null });
    const tid = await startTransition(h.db, "u-admin", cur!.id, "sj-2027-28");
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const now = new Date("2027-07-01T10:00:00Z");
    const kids = async (parentId: string) => (await h.db.select().from(parentChild).where(eq(parentChild.parentId, parentId))).length;
    const [kidsA, kidsB] = [await kids(pa.id), await kids(pb.id)];
    // „ohne“ steht in der Liste, hat aber keinen Vorschlag → ignoriert (neues Konto)
    const r = await admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: { [ja]: "5a", [nein]: "5a", [ohne]: "5a" }, linkSuggested: [ja, ohne] }, now);
    expect(r).toMatchObject({ students: 3, parentsCreated: 2, parentsLinked: 1, parentsSuggestedLinked: 1 });
    expect(await kids(pa.id)).toBe(kidsA + 1);
    expect(await kids(pb.id)).toBe(kidsB);
    expect(r.credentials.find((c) => c.kind === "Jan Vorschlag")).toMatchObject({ art: "Elternteil", password: "" });
    // ohne Haken: neues Elternkonto mit Platzhalter-Adresse (die echte Adresse hängt schon am anderen Konto)
    const nils = r.credentials.find((c) => c.kind === "Nils Vorschlag")!;
    expect(nils.password).not.toBe("");
    const [nilsParent] = await h.db.select().from(users).where(eq(users.username, nils.username));
    expect(nilsParent!.email).not.toBe("nein@example.org");
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schuljahreswechsel.neuaufnahmen"));
    expect(log!.meta).toMatchObject({ eltern_neu: 2, eltern_verknuepft: 1, eltern_vorschlag: 1 });
  }, 60_000);
});

describe("Neuaufnahmen: Startpasswörter neu erzeugen (Q5-21)", () => {
  let h: DbHandle;
  afterAll(async () => h?.close());

  it("nur für die angelegten Konten ohne eigenes Passwort, alte Passwörter/Sitzungen ungültig, Audit, nicht nach Abschluss", async () => {
    h = await createSeededTestDb();
    const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    const petra = await loadPermissions(h.db, "u-petra.lindner");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    // ein vorhandenes, bestätigtes Elternkonto wird verknüpft – sein Passwort bleibt
    const [known] = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern")).limit(1);
    await h.db.update(users).set({ email: "bekannt@example.org", emailVerified: true }).where(eq(users.id, known!.id));
    const add = async (first: string, email: string) =>
      (
        await insertAntrag(
          h.db,
          vid,
          { childFirstName: first, childLastName: "Neu", childBirthDate: "2016-04-03", primarySchool: "GS", parent1Name: `Eltern ${first}`, parent1Email: email, addressStreet: "Weg 1", addressZip: "45127", addressCity: "Essen" },
          { status: "eingegangen", now: new Date("2027-02-05T10:00:00Z") },
        )
      ).id;
    const a1 = await add("Anton", "anton@example.org");
    const a2 = await add("Berta", "berta@example.org");
    const a3 = await add("Cem", "bekannt@example.org");
    await decide(h.db, petra, vid, [a1, a2, a3], "aufgenommen", { school: "L", now: new Date("2027-03-01T10:00:00Z") });
    const tid = await startTransition(h.db, "u-admin", cur!.id, "sj-2027-28");
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    await expect(regenerateAdmissionPasswords(h.db, "u-admin", tid)).rejects.toMatchObject({ fieldErrors: { transition: /noch nicht/ } });
    const now = new Date("2027-07-01T10:00:00Z");
    const first = await admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign: { [a1]: "5a", [a2]: "5a", [a3]: "5a" } }, now);
    expect(first).toMatchObject({ students: 3, parentsCreated: 2, parentsLinked: 1 });
    const knownHash = (await h.db.select().from(accounts).where(eq(accounts.userId, known!.id)))[0]?.password;
    // Berta hat sich schon angemeldet und ein eigenes Passwort gesetzt → bleibt
    const berta = first.credentials.find((c) => c.name === "Berta Neu")!;
    await h.db.update(users).set({ mustChangePassword: false }).where(eq(users.username, berta.username));
    // Anton hat eine Sitzung mit dem alten Startpasswort
    const anton = first.credentials.find((c) => c.name === "Anton Neu")!;
    await h.db.insert(sessions).values({ id: "s-anton", token: "tok-anton", userId: `u-${anton.username}`, expiresAt: new Date("2027-08-01T00:00:00Z") });

    const r = await regenerateAdmissionPasswords(h.db, "u-admin", tid, now);
    // Anton, Cem, Elternkonten von Anton und Berta (Berta selbst nicht, das verknüpfte Konto nie)
    expect(r.skipped).toBe(1);
    expect(r.credentials.map((c) => `${c.art}:${c.name}`).sort()).toEqual(["Elternteil:Eltern Anton", "Elternteil:Eltern Berta", "Schüler:in:Anton Neu", "Schüler:in:Cem Neu"].sort());
    expect(r.credentials.find((c) => c.name === "Eltern Berta")).toMatchObject({ klasse: "5a", kind: "Berta Neu" });
    const newAnton = r.credentials.find((c) => c.name === "Anton Neu")!;
    expect(newAnton).toMatchObject({ klasse: "5a", username: anton.username });
    const [acc] = await h.db.select().from(accounts).where(eq(accounts.userId, `u-${anton.username}`));
    expect(await verifyPassword({ hash: acc!.password!, password: newAnton.password })).toBe(true);
    expect(await verifyPassword({ hash: acc!.password!, password: anton.password })).toBe(false);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, `u-${anton.username}`))).toEqual([]);
    expect((await h.db.select().from(accounts).where(eq(accounts.userId, known!.id)))[0]?.password).toBe(knownHash);
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schuljahreswechsel.startpasswoerter"));
    expect(log).toMatchObject({ actorId: "u-admin", target: tid, meta: { anzahl: 4, uebersprungen: 1 } });
    expect(JSON.stringify(log)).not.toMatch(/Anton|Berta/);
    expect(admissionCredentialsCsv(r.credentials)).toContain(newAnton.password);
    // GATE-031 C-04: Anton setzt sein Passwort, während die Startpasswörter erzeugt werden → bleibt unberührt
    const antonHash = (await h.db.select().from(accounts).where(eq(accounts.userId, `u-${anton.username}`)))[0]!.password;
    const race = await regenerateAdmissionPasswords(h.db, "u-admin", tid, now, {
      afterHash: async () => void (await h.db.update(users).set({ mustChangePassword: false }).where(eq(users.username, anton.username))),
    });
    expect(race.credentials.map((c) => c.name)).not.toContain("Anton Neu");
    expect(race.skipped).toBe(2);
    expect((await h.db.select().from(accounts).where(eq(accounts.userId, `u-${anton.username}`)))[0]!.password).toBe(antonHash);
    // nach dem Abschluss des Wechsels nicht mehr
    await h.db.update(schoolYearTransitions).set({ completedAt: now }).where(eq(schoolYearTransitions.id, tid));
    await expect(regenerateAdmissionPasswords(h.db, "u-admin", tid, now)).rejects.toMatchObject({ fieldErrors: { transition: /abgeschlossen/ } });
  }, 60_000);
});

describe("Neuaufnahmen: zweiter Elternteil (Q5-23)", () => {
  let h: DbHandle;
  afterAll(async () => h?.close());

  it("Elternteil 2 mit E-Mail: nur per Haken verknüpft (S-01), sonst neues Konto ohne die unbestätigte Adresse; ohne E-Mail kein Konto", async () => {
    h = await createSeededTestDb();
    const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    const petra = await loadPermissions(h.db, "u-petra.lindner");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    // vorhandene Elternkonten: eins mit bestätigter, zwei mit unbestätigter Adresse
    const [pv, pu, pn] = (await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern")).limit(3)) as [{ id: string }, { id: string }, { id: string }];
    await h.db.update(users).set({ email: "bestaetigt@example.org", emailVerified: true }).where(eq(users.id, pv.id));
    await h.db.update(users).set({ email: "vorschlag@example.org", emailVerified: false }).where(eq(users.id, pu.id));
    await h.db.update(users).set({ email: "ohnehaken@example.org", emailVerified: false }).where(eq(users.id, pn.id));
    const add = async (first: string, email: string, parent2Name: string | null, parent2Email: string | null) =>
      (
        await insertAntrag(
          h.db,
          vid,
          {
            childFirstName: first,
            childLastName: "Zwei",
            childBirthDate: "2016-04-03",
            primarySchool: "GS",
            parent1Name: `Eltern ${first}`,
            parent1Email: email,
            addressStreet: "Weg 1",
            addressZip: "45127",
            addressCity: "Essen",
            parent2Name,
            parent2Email,
          },
          { status: "eingegangen", now: new Date("2027-02-05T10:00:00Z") },
        )
      ).id;
    const anna = await add("Anna", "anna.eltern@example.org", "Bernd Zwei", "bernd@example.org");
    // Geschwisterkind mit vertauschten Rollen → dieselben zwei Elternkonten
    const bert = await add("Bert", "bernd@example.org", "Eltern Anna", "anna.eltern@example.org");
    const carla = await add("Carla", "carla@example.org", "Vera Bestätigt", "bestaetigt@example.org");
    const dora = await add("Dora", "dora@example.org", "Uwe Vorschlag", "vorschlag@example.org");
    const emil = await add("Emil", "emil@example.org", "Otto Ohnehaken", "ohnehaken@example.org");
    const fritz = await add("Fritz", "fritz@example.org", "Nur Name", null);
    const gina = await add("Gina", "gina@example.org", "Gleiche Adresse", "gina@example.org");
    const all = [anna, bert, carla, dora, emil, fritz, gina];
    await decide(h.db, petra, vid, all, "aufgenommen", { school: "L", now: new Date("2027-03-01T10:00:00Z") });

    const list = await pendingAdmissions(h.db, "sj-2027-28");
    const of = (id: string) => list.find((c) => c.antragId === id)!;
    // GATE-031 S-01: nie automatisch – auch bei bestätigter Adresse am Konto nur ein Vorschlag
    expect(of(anna).parent2).toMatchObject({ name: "Bernd Zwei", email: "bernd@example.org", suggestion: { kind: "antrag", name: "Eltern Bert" } });
    expect(of(bert).parent2).toMatchObject({ suggestion: { kind: "antrag", name: "Eltern Anna" } });
    expect(of(carla).parent2).toMatchObject({ suggestion: { kind: "konto", id: pv.id, verified: true } });
    expect(of(dora).parent2).toMatchObject({ suggestion: { kind: "konto", id: pu.id, verified: false } });
    expect(of(emil).parent2).toMatchObject({ suggestion: { kind: "konto", id: pn.id } });
    expect(of(fritz).parent2).toBeNull();
    expect(of(gina).parent2).toBeNull();

    const tid = await startTransition(h.db, "u-admin", cur!.id, "sj-2027-28");
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const now = new Date("2027-07-01T10:00:00Z");
    const assign = Object.fromEntries(all.map((id) => [id, "5a"]));
    // Haken: Dora (Konto), Anna (Antrag von Bert); nicht: Bert, Carla (bestätigtes fremdes Konto!), Emil; Fritz wirkungslos
    const r = await admitStudents(h.db, "u-admin", tid, { classes: { 5: ["5a"] }, assign, linkSuggested2: [dora, fritz, anna] }, now);
    // neu: Elternteil 1 von Anna, Bert (Bernd), Carla, Dora, Emil, Fritz, Gina + Elternteil 2 ohne Haken von Bert, Carla, Emil
    expect(r).toMatchObject({ students: 7, parentsCreated: 10, parentsLinked: 1, parentsSuggestedLinked: 1 });
    const childOf = async (antragId: string) => (await h.db.select({ u: anmeldungAntraege.transferredUserId }).from(anmeldungAntraege).where(eq(anmeldungAntraege.id, antragId)))[0]!.u!;
    const parentsOf = async (antragId: string) =>
      (await h.db.select({ p: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, await childOf(antragId)))).map((x) => x.p).sort();
    // Anna (Haken) teilt sich Bernd mit Bert; Berts Elternteil 2 ohne Haken → eigenes Konto, nicht Annas Elternteil 1
    const [bernd] = await h.db.select().from(users).where(eq(users.email, "bernd@example.org"));
    expect(bernd).toMatchObject({ role: "eltern", firstName: "Bernd", lastName: "Zwei", emailVerified: false, mustChangePassword: true });
    expect(await parentsOf(anna)).toContain(bernd!.id);
    expect(await parentsOf(bert)).toContain(bernd!.id);
    const [annaP1] = await h.db.select().from(users).where(eq(users.email, "anna.eltern@example.org"));
    expect(await parentsOf(bert)).not.toContain(annaP1!.id);
    expect(await parentsOf(bert)).toHaveLength(2);
    // Carla: das fremde, bestätigte Konto wird ohne Haken NICHT verknüpft (S-01)
    expect(await parentsOf(carla)).not.toContain(pv.id);
    expect(await parentsOf(carla)).toHaveLength(2);
    expect(await parentsOf(dora)).toContain(pu.id);
    expect(await parentsOf(emil)).not.toContain(pn.id);
    expect(await parentsOf(emil)).toHaveLength(2);
    expect(await parentsOf(fritz)).toHaveLength(1);
    expect(await parentsOf(gina)).toHaveLength(1);
    // neue Konten für Elternteil 2 ohne Haken bekommen nie die unbestätigte Adresse (sonst wäre sie für die Inhaberin blockiert)
    for (const [name, kind] of [["Vera Bestätigt", "Carla Zwei"], ["Otto Ohnehaken", "Emil Zwei"], ["Eltern Anna", "Bert Zwei"]] as const) {
      const cred = r.credentials.find((c) => c.name === name && c.kind === kind && c.password !== "")!;
      expect(cred, name).toBeDefined();
      const [u] = await h.db.select().from(users).where(eq(users.username, cred.username));
      expect(u!.email, name).not.toMatch(/@example.org$/);
    }
    // Zugangsdaten: Bernd einmal, mit beiden Kindern; verknüpfte Konten ohne Passwort
    const berndCred = r.credentials.filter((c) => c.name === "Bernd Zwei");
    expect(berndCred).toHaveLength(1);
    expect(berndCred[0]!.kind).toBe("Anna Zwei, Bert Zwei");
    expect(r.credentials.find((c) => c.kind === "Dora Zwei" && c.password === "")).toBeDefined();
    expect(admissionCredentialsCsv(r.credentials)).toContain("Bernd Zwei");
    // Q5-21: neu angelegte Elternteile 2 gehören zu den Konten für „Startpasswörter neu erzeugen“
    const [t] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(t!.admittedUsers).toContain(bernd!.id);
    expect(t!.admittedUsers).not.toContain(pv.id);
    expect(t!.admittedUsers).not.toContain(pu.id);
  }, 60_000);
});
