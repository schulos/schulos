import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, groups } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { can } from "@/core/permissions";
import { defineModule } from "@/core/modules/types";
import {
  addMembers,
  availableGroupFeatures,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  removeMember,
  searchCandidates,
  setGroupFeature,
  setMemberRole,
  slugify,
  updateGroup,
} from "./groups";
import { ValidationError } from "./users";

const ADMIN = "u-admin";

describe("Gruppenverwaltung", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("slugify", () => {
    expect(slugify("AG Schülerzeitung")).toBe("ag-schuelerzeitung");
    expect(slugify("  Q1 Mathe LK!! ")).toBe("q1-mathe-lk");
    expect(slugify("Café Été")).toBe("cafe-ete");
  });

  it("listet mit Mitgliederzahl, Leitung und Filter", async () => {
    const all = await listGroups(h.db);
    expect(all).toHaveLength(49); // inkl. Hausmeisterei (P4-10), Büchereiteam (BU-01) und Stundenplanung (SP-02)
    const k7b = (await listGroups(h.db, { q: "7b" })).find((g) => g.slug === "7b");
    expect(k7b?.members).toBeGreaterThanOrEqual(26);
    expect(k7b?.leaders).toEqual(["BRA"]);
    expect((await listGroups(h.db, { kind: "fachschaft" })).every((g) => g.kind === "fachschaft")).toBe(true);
  });

  it("legt an (mit eindeutigem Slug), ändert und löscht", async () => {
    const id = await createGroup(h.db, ADMIN, { name: "AG Schülerzeitung", kind: "ag" });
    const g = await getGroup(h.db, id);
    expect(g?.group.slug).toBe("ag-schuelerzeitung-2");
    expect(g?.group.schoolYearId).toBe("sj-2026-27");
    await updateGroup(h.db, ADMIN, id, { name: "AG Podcast", kind: "ag" });
    expect((await getGroup(h.db, id))?.group.name).toBe("AG Podcast");
    await deleteGroup(h.db, ADMIN, id);
    expect(await getGroup(h.db, id)).toBeNull();
    const log = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, id));
    expect(log.map((l) => l.action)).toEqual(["verwaltung.group.create", "verwaltung.group.update", "verwaltung.group.delete"]);
  });

  it("validiert", async () => {
    await expect(createGroup(h.db, ADMIN, { name: " ", kind: "ag" })).rejects.toThrow(ValidationError);
    await expect(createGroup(h.db, ADMIN, { name: "X", kind: "kurs", subjectId: "XYZ" })).rejects.toThrow(ValidationError);
    await expect(createGroup(h.db, ADMIN, { name: "X", kind: "klasse", gradeLevel: 14 })).rejects.toThrow(ValidationError);
    await expect(createGroup(h.db, ADMIN, { name: "X", kind: "klasse", homeRoomId: "999" })).rejects.toThrow(ValidationError);
  });

  it("Stammraum: Demo-Klassen haben einen, lässt sich ändern und leeren", async () => {
    expect((await getGroup(h.db, "g-7b"))?.group.homeRoomId).toMatch(/^1\d\d$/);
    const id = await createGroup(h.db, ADMIN, { name: "Klasse 5x", kind: "klasse", gradeLevel: 5, homeRoomId: "201" });
    expect((await getGroup(h.db, id))?.group.homeRoomId).toBe("201");
    await updateGroup(h.db, ADMIN, id, { name: "Klasse 5x", kind: "klasse", gradeLevel: 5, homeRoomId: null });
    expect((await getGroup(h.db, id))?.group.homeRoomId).toBeNull();
    await deleteGroup(h.db, ADMIN, id);
  });

  it("Mitglieder hinzufügen (idempotent), Leitung setzen, entfernen – Rechte folgen", async () => {
    const id = await createGroup(h.db, ADMIN, { name: "Theater-AG", kind: "ag" });
    expect(await addMembers(h.db, ADMIN, id, ["u-lea.schaefer", "u-jana.brandt"])).toBe(2);
    expect(await addMembers(h.db, ADMIN, id, ["u-lea.schaefer"])).toBe(0);
    await setMemberRole(h.db, ADMIN, id, "u-jana.brandt", "leader");
    expect(await can(h.db, "u-jana.brandt", "group.manage_members", { groupId: id })).toBe(true);
    const g = await getGroup(h.db, id);
    expect(g?.members[0]?.id).toBe("u-jana.brandt"); // Leitung zuerst
    await removeMember(h.db, ADMIN, id, "u-jana.brandt");
    expect(await can(h.db, "u-jana.brandt", "group.manage_members", { groupId: id })).toBe(false);
  });

  it("Kandidatensuche schließt bestehende Mitglieder aus", async () => {
    const res = await searchCandidates(h.db, "g-7b", "brandt");
    expect(res.map((r) => r.id)).not.toContain("u-jana.brandt");
    expect(await searchCandidates(h.db, "g-7b", "b")).toEqual([]);
    const okafor = await searchCandidates(h.db, "g-7b", "OKA");
    expect(okafor.map((r) => r.id)).toEqual(["u-daniel.okafor"]);
  });

  it("Gruppenmerkmale an/aus", async () => {
    const mods = [defineModule({ id: "dateien", name: "Dateien", description: "", icon: "Folder", section: "unterricht", groupFeatures: { "dateien.gruppenordner": "Gruppenordner" } })];
    expect(availableGroupFeatures(mods)).toEqual([{ id: "dateien.gruppenordner", label: "Gruppenordner", moduleId: "dateien", moduleName: "Dateien" }]);
    await setGroupFeature(h.db, ADMIN, "g-7b", "dateien.gruppenordner", true);
    await setGroupFeature(h.db, ADMIN, "g-7b", "dateien.gruppenordner", true);
    expect((await getGroup(h.db, "g-7b"))?.features).toContain("dateien.gruppenordner");
    await setGroupFeature(h.db, ADMIN, "g-7b", "dateien.gruppenordner", false);
    expect((await getGroup(h.db, "g-7b"))?.features).not.toContain("dateien.gruppenordner");
  });

  it("Löschen einer Gruppe entfernt Mitgliedschaften (Cascade)", async () => {
    const id = await createGroup(h.db, ADMIN, { name: "Temp", kind: "frei" });
    await addMembers(h.db, ADMIN, id, ["u-lea.schaefer"]);
    await deleteGroup(h.db, ADMIN, id);
    expect(await h.db.select().from(groups).where(eq(groups.id, id))).toHaveLength(0);
  });
});

describe("Gruppen → Gong", () => {
  it("benachrichtigt neu hinzugefügte Mitglieder (nicht sich selbst)", async () => {
    const { listNotifications } = await import("@/core/notifications");
    const h = await createSeededTestDb();
    const id = await createGroup(h.db, "u-jana.brandt", { name: "AG Garten", kind: "ag" });
    await addMembers(h.db, "u-jana.brandt", id, ["u-lea.schaefer", "u-jana.brandt"]);
    expect((await listNotifications(h.db, "u-lea.schaefer"))[0]?.title).toBe("Du bist jetzt in „AG Garten“");
    expect(await listNotifications(h.db, "u-jana.brandt")).toEqual([]);
    await h.close();
  }, 60_000);
});
