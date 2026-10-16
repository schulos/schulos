// Q5-05: Kennzeichen „eigenständig (volljährig)“ – wer handelt, wer sieht was (Eltern mit und ohne Einwilligung).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, notifications, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { consentAuthority } from "@/core/privacy/profilbild";
import { childrenOf, guardianRecipients, isSelfResponsible, selfResponsibleIds } from "@/core/school/majority";
import { visiblePeople } from "@/modules/adressbuch/service";
import { afterUnexcused, ownAbsences } from "@/modules/abwesenheiten/fehlzeiten";
import { confirmLetter, createLetter, letterFor, listLetters } from "@/modules/elternbriefe/service";
import { planOwners } from "@/modules/stundenplan/service";
import { createSurvey, listForParticipant, resolveAudience } from "@/modules/umfragen/service";
import { executeImport, parseStudentCsv, planImport } from "./import";
import { ValidationError } from "./users";
import { parentsInformedState, setParentsInformed, setSelfResponsible } from "./volljaehrig";

const LEA = "u-lea.schaefer";
const NOW = new Date("2026-10-05T08:00:00Z");

describe("Q5-05 eigenständig (volljährig)", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let mutter: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const peopleFor = async (viewerId: string) => {
    const cond = await visiblePeople(h.db, await p(viewerId));
    return (await h.db.select({ id: users.id }).from(users).where(cond)).map((r) => r.id);
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-q505-"));
    storage = localStorage(dir);
    const [link] = await h.db.select().from(parentChild).where(eq(parentChild.childId, LEA));
    mutter = link!.parentId;
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Vorgabe: niemand ist eigenständig, Eltern sehen und handeln", async () => {
    expect(await selfResponsibleIds(h.db, [LEA])).toEqual(new Set());
    expect((await childrenOf(h.db, mutter, "act")).map((k) => k.id)).toContain(LEA);
    expect(await guardianRecipients(h.db, [LEA], { withInformed: true })).toEqual(expect.arrayContaining([mutter]));
    expect(await guardianRecipients(h.db, [LEA], { withInformed: true })).not.toContain(LEA);
  });

  it("nur die Verwaltung setzt das Kennzeichen, nur bei Schüler:innen; Gong an die Person, Audit", async () => {
    await expect(setSelfResponsible(h.db, "u-sabine.kowalski", "u-jana.brandt", true)).rejects.toBeInstanceOf(ValidationError);
    await setSelfResponsible(h.db, "u-sabine.kowalski", LEA, true);
    expect(await isSelfResponsible(h.db, LEA)).toBe(true);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, LEA), eq(notifications.moduleId, "verwaltung")));
    expect(gong.map((g) => g.title)).toContain("Du handelst jetzt eigenständig");
    const log = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "verwaltung.user.eigenstaendig"), eq(auditLog.target, LEA)));
    expect(log).toHaveLength(1);
    // nur die Person selbst willigt ein – Eltern können es nicht
    await expect(setParentsInformed(h.db, mutter, true)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Elternsicht erlischt: Adressbuch, Stundenplan, Klausuren, Fehlzeiten", async () => {
    expect(await peopleFor(mutter)).not.toContain(LEA);
    expect((await planOwners(h.db, await p(mutter))).map((o) => o.id)).not.toContain(LEA);
    expect((await childrenOf(h.db, mutter, "inform")).map((k) => k.id)).not.toContain(LEA);
    await expect(ownAbsences(h.db, await p(mutter), LEA, "2026-10-05")).rejects.toBeInstanceOf(ForbiddenError);
    // die Person selbst sieht ihre Fehlzeiten weiter
    await expect(ownAbsences(h.db, await p(LEA), LEA, "2026-10-05")).resolves.toBeTruthy();
  });

  it("Elternbrief geht an die Person selbst – sie bestätigt, die Eltern sehen ihn nicht", async () => {
    const id = await createLetter(h.db, storage, await p("u-jana.brandt"), { title: "Studienfahrt", body: "Infos", groupIds: ["g-7b"], responseType: "yesno", question: "Teilnahme?", dueDate: null });
    const gongs = await h.db.select({ userId: notifications.userId }).from(notifications).where(and(eq(notifications.moduleId, "elternbriefe"), eq(notifications.title, "Elternbrief: Studienfahrt")));
    expect(gongs.map((g) => g.userId)).toContain(LEA);
    expect(gongs.map((g) => g.userId)).not.toContain(mutter);
    expect(await letterFor(h.db, await p(mutter), id)).toBeNull();
    const own = await letterFor(h.db, await p(LEA), id);
    expect(own).toMatchObject({ mode: "parent", receipts: [{ studentId: LEA, canConfirm: true }] });
    expect((await listLetters(h.db, await p(LEA))).map((l) => l.title)).toContain("Studienfahrt");
    await confirmLetter(h.db, await p(LEA), id, LEA, { yes: true, text: "" });
    await expect(confirmLetter(h.db, await p(mutter), id, LEA, { yes: false, text: "" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Eltern-Umfrage geht an die Person selbst, nicht an die Eltern", async () => {
    const survey = await createSurvey(
      h.db,
      await p("u-jana.brandt"),
      {
        title: "Elternabend-Termin",
        description: "",
        anonymous: false,
        opensAt: new Date("2026-10-05T06:00:00Z"),
        closesAt: new Date("2026-10-12T20:00:00Z"),
        targets: { roles: [], groups: [{ groupId: "g-7b", parents: true }] },
        questions: [{ kind: "single", text: "Wann?", options: ["Di", "Do"], required: true }],
      },
      NOW,
    );
    const audience = await resolveAudience(h.db, survey);
    expect(audience).toContain(LEA);
    expect(audience).not.toContain(mutter);
    expect((await listForParticipant(h.db, await p(LEA), NOW)).map((s) => s.title)).toContain("Elternabend-Termin");
    expect((await listForParticipant(h.db, await p(mutter), NOW)).map((s) => s.title)).not.toContain("Elternabend-Termin");
  });

  it("„nicht entschuldigt“ erfährt die Person selbst; Profilbild entscheidet sie selbst", async () => {
    await afterUnexcused(h.db, LEA, "Mo, 5.10.", "2026-10-05");
    const titles = async (id: string) =>
      (await h.db.select({ t: notifications.title }).from(notifications).where(and(eq(notifications.userId, id), eq(notifications.moduleId, "abwesenheiten")))).map((r) => r.t);
    expect((await titles(LEA)).some((t) => t.includes("nicht entschuldigt"))).toBe(true);
    expect((await titles(mutter)).some((t) => t.includes("nicht entschuldigt"))).toBe(false);
    const target = { id: LEA, role: "schueler", selfResponsible: true };
    expect(consentAuthority(await p(LEA), target, false)).toBe("self");
    expect(consentAuthority(await p(mutter), target, true)).toBeNull();
  });

  it("Einwilligung „Eltern weiter informieren“: Eltern sehen wieder, handeln aber nicht", async () => {
    await setParentsInformed(h.db, LEA, true, NOW);
    expect((await parentsInformedState(h.db, LEA)).since).toEqual(NOW);
    expect(await peopleFor(mutter)).toContain(LEA);
    expect((await planOwners(h.db, await p(mutter))).map((o) => o.id)).toContain(LEA);
    await expect(ownAbsences(h.db, await p(mutter), LEA, "2026-10-05")).resolves.toBeTruthy();
    const id = await createLetter(h.db, storage, await p("u-jana.brandt"), { title: "Abiball", body: "Infos", groupIds: ["g-7b"], responseType: "none", question: "", dueDate: null });
    const view = await letterFor(h.db, await p(mutter), id);
    expect(view).toMatchObject({ mode: "parent", receipts: [{ studentId: LEA, canConfirm: false }] });
    await expect(confirmLetter(h.db, await p(mutter), id, LEA, { yes: null, text: "" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await guardianRecipients(h.db, [LEA], { withInformed: false })).toEqual([LEA]);
    expect((await childrenOf(h.db, mutter, "act")).map((k) => k.id)).not.toContain(LEA);

    // Widerruf → wieder nichts; Kennzeichen entfernen nimmt die Einwilligung mit
    await setParentsInformed(h.db, LEA, false);
    expect(await peopleFor(mutter)).not.toContain(LEA);
    await setParentsInformed(h.db, LEA, true);
    await setSelfResponsible(h.db, "u-sabine.kowalski", LEA, false);
    expect(await parentsInformedState(h.db, LEA)).toEqual({ selfResponsible: false, since: null });
    expect((await childrenOf(h.db, mutter, "act")).map((k) => k.id)).toContain(LEA);
  });

  it("Import: optionale Spalte „Eigenständig“", async () => {
    const csv = "Vorname;Nachname;Klasse;Eigenständig\nJonas;Q-Test;7b;ja\nMia;Q-Test;7b;\n";
    const { rows } = parseStudentCsv(csv);
    expect(rows.map((r) => r.selfResponsible ?? false)).toEqual([true, false]);
    const res = await executeImport(h.db, "u-sabine.kowalski", await planImport(h.db, rows));
    expect(res.created).toHaveLength(2);
    const flags = await h.db.select({ name: users.firstName, s: users.selfResponsible }).from(users).where(eq(users.lastName, "Q-Test"));
    expect(Object.fromEntries(flags.map((f) => [f.name, f.s]))).toEqual({ Jonas: true, Mia: false });
  });
});
