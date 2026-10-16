import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupFeatures, groups, textDocs } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { forgetDoc, openDocIds, syncDoc } from "./live";
import { createDoc, deleteDoc, docAccess, docGroups, exportFilename, exportMarkdown, listDocs, TEXT_FEATURE, updateDoc } from "./service";

const DOC = "text-7b-regeln";

describe("Texte – Rechte und Metadaten", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(async () => {
    for (const id of openDocIds()) forgetDoc(id);
    await h.close();
  });

  it("Mitglieder lesen und schreiben, Leitung verwaltet, Fremde sehen nichts", async () => {
    const lea = await docAccess(h.db, await p("u-lea.schaefer"), DOC);
    expect(lea).toMatchObject({ role: "member", canWrite: true, groupName: "Klasse 7b", archived: false });
    const jana = await docAccess(h.db, await p("u-jana.brandt"), DOC);
    expect(jana).toMatchObject({ role: "leader", canWrite: true });
    expect(await docAccess(h.db, await p("u-daniel.okafor"), DOC)).toBeNull();
    expect(await docAccess(h.db, await p("u-lea.schaefer"), "gibts-nicht")).toBeNull();
    expect((await listDocs(h.db, await p("u-lea.schaefer"))).map((d) => d.id)).toContain(DOC);
    expect((await listDocs(h.db, await p("u-daniel.okafor"))).map((d) => d.id)).not.toContain(DOC);
  });

  it("Merkmal aus → kein Zugriff, auch nicht für die Leitung", async () => {
    await h.db.delete(groupFeatures).where(and(eq(groupFeatures.groupId, "g-7b"), eq(groupFeatures.feature, TEXT_FEATURE)));
    try {
      expect(await docAccess(h.db, await p("u-jana.brandt"), DOC)).toBeNull();
      expect(await listDocs(h.db, await p("u-lea.schaefer"))).toEqual([]);
      expect((await docGroups(h.db, await p("u-jana.brandt"))).map((g) => g.id)).not.toContain("g-7b");
    } finally {
      await h.db.insert(groupFeatures).values({ groupId: "g-7b", feature: TEXT_FEATURE });
    }
  });

  it("Modus „leitung“: Mitglieder lesen nur; Umbenennen geht live an Anwesende; archivierte Gruppe nur lesen", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    await expect(updateDoc(h.db, lea, DOC, { title: "x", mode: "alle" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDoc(h.db, jana, DOC, { title: "   ", mode: "alle" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateDoc(h.db, jana, DOC, { title: "Regeln", mode: "egal" })).rejects.toBeInstanceOf(ValidationError);

    const got: LiveEvent[] = [];
    await syncDoc(h.db, DOC, "u-lea.schaefer", null); // Lea hat den Text offen
    const off = subscribe("u-lea.schaefer", (e) => got.push(e));
    await updateDoc(h.db, jana, DOC, { title: "Klassenregeln 7b", mode: "leitung" });
    off();
    expect(got).toEqual([{ type: "text", docId: DOC, title: "Klassenregeln 7b" }]);
    expect(await docAccess(h.db, lea, DOC)).toMatchObject({ canWrite: false, role: "member" });
    expect(await docAccess(h.db, jana, DOC)).toMatchObject({ canWrite: true });
    await updateDoc(h.db, jana, DOC, { title: "Klassenregeln", mode: "alle" });

    await h.db.update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, "g-7b"));
    try {
      expect(await docAccess(h.db, jana, DOC)).toMatchObject({ canWrite: false, archived: true });
      expect((await docGroups(h.db, jana)).map((g) => g.id)).not.toContain("g-7b");
    } finally {
      await h.db.update(groups).set({ archivedAt: null }).where(eq(groups.id, "g-7b"));
    }
  });

  it("anlegen nur in eigenen Gruppen mit Merkmal (Leitung/Personal); löschen nur Leitung, Anwesende erfahren es", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    await expect(createDoc(h.db, lea, { title: "Mein Text", mode: "alle", groupId: "g-7b" })).rejects.toBeInstanceOf(ForbiddenError);
    // eine Gruppe mit Merkmal, in der Jana nicht Mitglied ist
    const foreign = (await h.db.select({ id: groupFeatures.groupId }).from(groupFeatures).where(eq(groupFeatures.feature, TEXT_FEATURE))).find((g) => !jana.memberOf.has(g.id))!;
    await expect(createDoc(h.db, jana, { title: "Fremd", mode: "alle", groupId: foreign.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDoc(h.db, jana, { title: "", mode: "alle", groupId: "g-7b" })).rejects.toBeInstanceOf(ValidationError);
    const id = await createDoc(h.db, jana, { title: "Protokoll Klassenrat", mode: "leitung", groupId: "g-7b" });
    expect(await docAccess(h.db, lea, id)).toMatchObject({ canWrite: false });
    expect((await exportMarkdown(h.db, lea, id))!.markdown).toBe("");

    await expect(deleteDoc(h.db, lea, id)).rejects.toBeInstanceOf(ForbiddenError);
    await syncDoc(h.db, id, "u-lea.schaefer", null);
    const got: LiveEvent[] = [];
    const off = subscribe("u-lea.schaefer", (e) => got.push(e));
    await deleteDoc(h.db, jana, id);
    off();
    expect(got).toEqual([{ type: "text", docId: id, removed: true }]);
    expect(await h.db.select().from(textDocs).where(eq(textDocs.id, id))).toEqual([]);
    expect(openDocIds()).not.toContain(id);
  });

  it("Export: Markdown aus dem Seed-Text, Dateiname ohne Sonderzeichen", async () => {
    const out = await exportMarkdown(h.db, await p("u-lea.schaefer"), DOC);
    expect(out!.title).toBe("Klassenregeln");
    expect(out!.markdown).toContain("# Unsere Klassenregeln");
    expect(out!.markdown).toContain("- Wir lassen einander ausreden.");
    expect(out!.markdown).toContain("**Klassenrat**");
    expect(await exportMarkdown(h.db, await p("u-daniel.okafor"), DOC)).toBeNull();
    expect(exportFilename("Protokoll Klassenrat: Müll & Ordnung / Größe")).toBe("Protokoll-Klassenrat-Muell-Ordnung-Groesse.md");
    expect(exportFilename("???")).toBe("text.md");
  });
});
