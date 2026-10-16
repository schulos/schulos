import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DbHandle } from "@/core/db/client";
import { auditLog, fileNodes } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage } from "@/core/files/storage";
import { readZip } from "@/core/zip";
import { taskFiles, tasks, taskSubmissions } from "@/modules/aufgaben/schema";
import { ExportTooLargeError, MAX_EXPORT_BYTES } from "@/core/export-limit";
import { buildOwnExport, planOwnExport } from "./eigenexport";

describe("Eigenexport (Demo-Schule)", () => {
  let h: DbHandle;
  let dir: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-eigen-"));
  });
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Ordnerstruktur, Abgaben mit Rückmeldung, eigene Aufgaben; doppelte Namen werden nummeriert", async () => {
    const storage = localStorage(dir);
    const k1 = crypto.randomUUID();
    const k2 = crypto.randomUUID();
    const k3 = crypto.randomUUID();
    for (const [k, t] of [
      [k1, "Notizen"],
      [k2, "Notizen 2"],
      [k3, "Lösung"],
    ] as const)
      await storage.put(k, new TextEncoder().encode(t));
    const [folder] = await h.db.insert(fileNodes).values({ kind: "folder", name: "Bio", ownerId: "u-lea.schaefer" }).returning();
    await h.db.insert(fileNodes).values([
      { kind: "file", name: "zelle.txt", ownerId: "u-lea.schaefer", parentId: folder!.id, storageKey: k1, size: 7 },
      { kind: "file", name: "Zelle.txt", ownerId: "u-lea.schaefer", parentId: folder!.id, storageKey: k2, size: 9 },
    ]);
    const [task] = await h.db
      .insert(tasks)
      .values({ title: "Referat: Zelle/Organ", authorId: "u-jana.brandt", dueAt: new Date("2026-10-10T10:00:00Z"), startsAt: new Date("2026-10-01T10:00:00Z") })
      .returning();
    const [sub] = await h.db
      .insert(taskSubmissions)
      .values({ taskId: task!.id, studentId: "u-lea.schaefer", text: "Mein Text", feedback: "Gut gemacht", grade: "2+", returnedAt: new Date() })
      .returning();
    await h.db.insert(taskFiles).values({ taskId: task!.id, submissionId: sub!.id, name: "loesung.txt", mime: "text/plain", size: 6, storageKey: k3, uploadedBy: "u-lea.schaefer" });

    const plan = await planOwnExport(h.db, "u-lea.schaefer");
    const paths = plan.entries.map((e) => e.path);
    expect(paths).toContain("Meine Dateien/Bio/Zelle.txt");
    expect(paths).toContain("Meine Dateien/Bio/zelle (2).txt");
    expect(paths).toContain("Abgaben/2026-10-10 Referat_ Zelle_Organ/abgabe.txt");
    expect(paths).toContain("Abgaben/2026-10-10 Referat_ Zelle_Organ/loesung.txt");
    expect(plan.counts.files).toBe(2);

    const res = await buildOwnExport(h.db, storage, "u-lea.schaefer", new Date("2026-10-05T10:00:00Z"));
    expect(res.filename).toBe("meine-daten_lea.schaefer_2026-10-05.zip");
    const zip = readZip(res.zip);
    const abgabe = new TextDecoder().decode(zip.get("Abgaben/2026-10-10 Referat_ Zelle_Organ/abgabe.txt"));
    expect(abgabe).toContain("Mein Text");
    expect(abgabe).toContain("Bewertung: 2+");
    expect(abgabe).toContain("Gut gemacht");
    expect(new TextDecoder().decode(zip.get("Meine Dateien/Bio/zelle (2).txt"))).toBe("Notizen");
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.eigenexport"))).length).toBe(1);

    const jana = await planOwnExport(h.db, "u-jana.brandt");
    expect(jana.entries.some((e) => e.path.startsWith("Meine Aufgaben/2026-10-10 Referat_ Zelle_Organ/aufgabe.md"))).toBe(true);
  });
  it("SEC-05: zu große Exporte brechen vor dem Lesen ab, ohne Audit-Eintrag", async () => {
    const storage = localStorage(dir);
    await h.db.insert(fileNodes).values({ kind: "file", name: "riesig.bin", ownerId: "u-jana.brandt", storageKey: crypto.randomUUID(), size: MAX_EXPORT_BYTES + 1 });
    expect((await planOwnExport(h.db, "u-jana.brandt")).bytes).toBeGreaterThan(MAX_EXPORT_BYTES);
    await expect(buildOwnExport(h.db, storage, "u-jana.brandt")).rejects.toBeInstanceOf(ExportTooLargeError);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.eigenexport"));
    expect(audits.filter((a) => a.actorId === "u-jana.brandt")).toEqual([]);
  });
});
