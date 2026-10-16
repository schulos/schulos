import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { confirmLetter, createLetter, letterAttachment, letterFor, listLetters, markRead, remindLetter, sendableGroups, type LetterInput } from "./service";

const base: LetterInput = {
  title: "Wandertag am 7.10.",
  body: "Liebe Eltern,\n\nam **Mittwoch** wandern wir zum Lindenhof.",
  groupIds: ["g-7b"],
  responseType: "yesno",
  question: "Darf Ihr Kind teilnehmen?",
  dueDate: "2026-10-06",
};

describe("Elternbriefe", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let mutter: string;
  let fremdeMutter: string;
  let letterId: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-letters-"));
    storage = localStorage(dir);
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    const kid9a = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    fremdeMutter = (await h.db.select().from(parentChild).where(eq(parentChild.childId, kid9a)))[0]!.parentId;
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Lehrkraft schreibt nur an eigene Gruppen, Sekretariat an alle Klassen", async () => {
    const jana = await p("u-jana.brandt");
    const own = (await sendableGroups(h.db, jana)).map((g) => g.id);
    expect(own).toContain("g-7b");
    expect(own).not.toContain("g-9b");
    expect((await sendableGroups(h.db, await p("u-sabine.kowalski"))).filter((g) => g.id.match(/^g-\d/)).length).toBe(12);
    await expect(createLetter(h.db, storage, jana, { ...base, groupIds: ["g-9b"] })).rejects.toMatchObject({ fieldErrors: { groupIds: expect.any(String) } });
    await expect(createLetter(h.db, storage, await p(mutter), base)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Versand: ein Eintrag je Kind, Gong an alle Eltern, Anhang", async () => {
    letterId = await createLetter(h.db, storage, await p("u-jana.brandt"), { ...base, attachment: { name: "Infos.pdf", type: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) } });
    const view = await letterFor(h.db, await p("u-jana.brandt"), letterId);
    expect(view!.mode).toBe("manage");
    expect(view!.receipts).toHaveLength(25);
    expect(view!.groupNames).toEqual(["Klasse 7b"]);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, mutter), eq(notifications.moduleId, "elternbriefe")));
    expect(gong.map((g) => g.title)).toEqual(["Elternbrief: Wandertag am 7.10."]);
    expect((await letterAttachment(h.db, await p(mutter), letterId))!.name).toBe("Infos.pdf");
    expect(await letterAttachment(h.db, await p(fremdeMutter), letterId)).toBeNull();
  });

  it("Eltern sehen nur die eigenen Kinder, lesen und bestätigen mit Antwort", async () => {
    const m = await p(mutter);
    const view = await letterFor(h.db, m, letterId);
    expect(view!.mode).toBe("parent");
    expect(view!.receipts.map((r) => r.studentName)).toEqual(["Lea Schäfer"]);
    expect(await letterFor(h.db, await p(fremdeMutter), letterId)).toBeNull();
    await markRead(h.db, m, letterId);
    expect((await letterFor(h.db, m, letterId))!.receipts[0]!.readAt).not.toBeNull();
    await expect(confirmLetter(h.db, m, letterId, "u-lea.schaefer", { yes: null, text: "" })).rejects.toBeInstanceOf(ValidationError);
    await confirmLetter(h.db, m, letterId, "u-lea.schaefer", { yes: true, text: "ignoriert" });
    const r = (await letterFor(h.db, await p("u-jana.brandt"), letterId))!.receipts.find((x) => x.studentId === "u-lea.schaefer")!;
    expect(r).toMatchObject({ answerYes: true, answerText: null, confirmedByName: "Daniela Schäfer" });
    await expect(confirmLetter(h.db, await p(fremdeMutter), letterId, "u-lea.schaefer", { yes: false, text: "" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Übersicht mit Fortschritt; Erinnern nur an Offene und höchstens alle 12 Stunden", async () => {
    const [s] = await listLetters(h.db, await p("u-jana.brandt"));
    expect(s).toMatchObject({ title: "Wandertag am 7.10.", total: 25, confirmed: 1 });
    const parentList = await listLetters(h.db, await p(mutter));
    expect(parentList[0]).toMatchObject({ confirmed: 1, openFor: [] });
    const now = new Date("2026-10-05T10:00:00Z");
    const reminded = await remindLetter(h.db, await p("u-jana.brandt"), letterId, now);
    expect(reminded).toBeGreaterThan(15);
    expect((await h.db.select().from(notifications).where(and(eq(notifications.userId, mutter), eq(notifications.moduleId, "elternbriefe")))).some((g) => g.title.startsWith("Erinnerung"))).toBe(false);
    await expect(remindLetter(h.db, await p("u-jana.brandt"), letterId, new Date(now.getTime() + 3600_000))).rejects.toBeInstanceOf(ValidationError);
    await expect(remindLetter(h.db, await p("u-daniel.okafor"), letterId, new Date(now.getTime() + 86_400_000))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
