import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { listNotifications } from "@/core/notifications";
import { loadPermissions } from "@/core/permissions";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import {
  createTask,
  getTask,
  getTaskFile,
  giveFeedback,
  listForStudent,
  listForTeacher,
  statusOf,
  studentsOfTask,
  submissionMatrix,
  submit,
} from "./service";

const bytes = (s: string) => new TextEncoder().encode(s);
const H = 3_600_000;

describe("statusOf", () => {
  const due = new Date("2026-10-07T22:00:00Z");
  it.each([
    [null, new Date("2026-10-06T10:00:00Z"), "offen"],
    [null, new Date("2026-10-08T10:00:00Z"), "fehlt"],
    [{ submittedAt: new Date("2026-10-07T10:00:00Z"), returnedAt: null }, new Date(), "abgegeben"],
    [{ submittedAt: new Date("2026-10-08T10:00:00Z"), returnedAt: null }, new Date(), "verspaetet"],
    [{ submittedAt: new Date("2026-10-08T10:00:00Z"), returnedAt: new Date() }, new Date(), "zurueckgegeben"],
  ] as const)("%o @ %s → %s", (sub, now, expected) => {
    expect(statusOf(due, sub, now)).toBe(expected);
  });
});

describe("Aufgaben – Ablauf", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let mitschueler: string;
  let fremd: string;
  let taskId: string;
  const now = new Date();
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-tasks-"));
    storage = localStorage(dir);
    mitschueler = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.find((r) => r.id !== "u-lea.schaefer")!.id;
    fremd = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  const p = (id: string) => loadPermissions(h.db, id);

  it("nur Lehrkräfte mit Recht, nur eigene Gruppen, Frist nach Start", async () => {
    await expect(createTask(h.db, storage, await p("u-lea.schaefer"), { title: "x", description: "", groupIds: ["g-7b"], dueAt: new Date(Date.now() + H), submissionType: "text" })).rejects.toThrow(ValidationError);
    const brandt = await p("u-jana.brandt");
    await expect(createTask(h.db, storage, brandt, { title: "x", description: "", groupIds: ["g-9a"], dueAt: new Date(Date.now() + H), submissionType: "text" })).rejects.toMatchObject({ fieldErrors: { groupIds: expect.any(String) } });
    await expect(createTask(h.db, storage, brandt, { title: "x", description: "", groupIds: ["g-7b"], dueAt: new Date(Date.now() - H), submissionType: "text" })).rejects.toMatchObject({ fieldErrors: { dueAt: expect.any(String) } });
  });

  it("Aufgabe stellen → alle Schüler:innen der 7b bekommen einen Gong, sonst niemand", async () => {
    taskId = await createTask(h.db, storage, await p("u-jana.brandt"), {
      title: "Erörterung „Handyverbot“",
      description: "Schreibe eine **Erörterung**.",
      groupIds: ["g-7b"],
      dueAt: new Date(now.getTime() + 48 * H),
      submissionType: "file",
      files: [{ name: "Material.txt", type: "text/plain", data: bytes("Pro und Contra") }],
    }, now);
    expect((await studentsOfTask(h.db, taskId)).length).toBe(25);
    expect((await listNotifications(h.db, "u-lea.schaefer"))[0]?.title).toBe("Neue Aufgabe: Erörterung „Handyverbot“");
    expect(await listNotifications(h.db, fremd)).toEqual([]);
    expect(await listNotifications(h.db, "u-jana.brandt")).toEqual([]);
  });

  it("Sichtbarkeit: 7b ja, 9a nein; geplante Aufgaben erst ab Start", async () => {
    expect((await listForStudent(h.db, await p("u-lea.schaefer"), now)).map((t) => t.id)).toContain(taskId);
    expect(await getTask(h.db, await p(fremd), taskId)).toBeNull();
    const later = await createTask(h.db, storage, await p("u-jana.brandt"), { title: "Später", description: "", groupIds: ["g-7b"], startsAt: new Date(now.getTime() + 24 * H), dueAt: new Date(now.getTime() + 72 * H), submissionType: "confirm" }, now);
    expect((await listForStudent(h.db, await p("u-lea.schaefer"), now)).map((t) => t.id)).not.toContain(later);
    expect((await listForStudent(h.db, await p("u-lea.schaefer"), new Date(now.getTime() + 25 * H))).map((t) => t.id)).toContain(later);
  });

  it("Abgabe: Dateipflicht, Gong an Lehrkraft, Neuabgabe ersetzt Dateien", async () => {
    const lea = await p("u-lea.schaefer");
    await expect(submit(h.db, storage, lea, taskId, { text: "nur Text" }, now)).rejects.toMatchObject({ fieldErrors: { files: expect.any(String) } });
    await submit(h.db, storage, lea, taskId, { files: [{ name: "v1.txt", type: "text/plain", data: bytes("Entwurf") }] }, now);
    await submit(h.db, storage, lea, taskId, { text: "Endfassung anbei", files: [{ name: "v2.txt", type: "text/plain", data: bytes("Final") }] }, now);
    const t = await getTask(h.db, lea, taskId, now);
    expect(t?.status).toBe("abgegeben");
    expect(t?.mine?.files.map((f) => f.name)).toEqual(["v2.txt"]);
    const gong = await listNotifications(h.db, "u-jana.brandt");
    expect(gong[0]?.title).toBe("Lea Schäfer hat „Erörterung „Handyverbot““ abgegeben");
    expect(gong[0]?.href).toBe(`/aufgaben/${taskId}/abgabe/u-lea.schaefer`);
  });

  it("Dateizugriff: Aufgaben-Anhang für die Klasse, Abgabe nur für Eigentümerin und Lehrkraft", async () => {
    const lea = await p("u-lea.schaefer");
    const t = await getTask(h.db, lea, taskId, now);
    const anhang = t!.files[0]!.id;
    const abgabe = t!.mine!.files[0]!.id;
    expect(await getTaskFile(h.db, await p(mitschueler), anhang)).not.toBeNull();
    expect(await getTaskFile(h.db, await p(mitschueler), abgabe)).toBeNull();
    expect(await getTaskFile(h.db, await p("u-jana.brandt"), abgabe)).not.toBeNull();
    expect(await getTaskFile(h.db, await p(fremd), anhang)).toBeNull();
  });

  it("Matrix, Feedback, Rückgabe → Gong an Schülerin, danach keine Neuabgabe", async () => {
    const brandt = await p("u-jana.brandt");
    const m = await submissionMatrix(h.db, brandt, taskId, now);
    expect(m?.rows.find((r) => r.student.id === "u-lea.schaefer")?.status).toBe("abgegeben");
    expect(m?.rows.filter((r) => r.status === "offen")).toHaveLength(24);
    expect(await submissionMatrix(h.db, await p("u-lea.schaefer"), taskId)).toBeNull();
    await expect(giveFeedback(h.db, brandt, taskId, mitschueler, { feedback: "x" })).rejects.toThrow(ValidationError);

    await giveFeedback(h.db, brandt, taskId, "u-lea.schaefer", { feedback: "Gut begründet!", grade: "2+" }, now);
    const lea = await p("u-lea.schaefer");
    const t = await getTask(h.db, lea, taskId, now);
    expect(t?.status).toBe("zurueckgegeben");
    expect(t?.mine?.grade).toBe("2+");
    expect((await listNotifications(h.db, "u-lea.schaefer"))[0]).toMatchObject({ title: "Feedback zu „Erörterung „Handyverbot““", body: "Bewertung: 2+" });
    await expect(submit(h.db, storage, lea, taskId, { files: [{ name: "v3.txt", type: "text/plain", data: bytes("x") }] }, now)).rejects.toThrow(ValidationError);
  });

  it("Lehrkraft-Übersicht zählt Abgaben und Rückgaben; nach der Frist: fehlt / verspätet", async () => {
    const list = await listForTeacher(h.db, await p("u-jana.brandt"));
    expect(list.find((t) => t.id === taskId)).toMatchObject({ students: 25, submitted: 1, returned: 1, groups: ["Klasse 7b"] });
    const after = new Date(now.getTime() + 49 * H);
    const m = await submissionMatrix(h.db, await p("u-jana.brandt"), taskId, after);
    expect(m?.rows.filter((r) => r.status === "fehlt")).toHaveLength(24);
    await submit(h.db, storage, await p(mitschueler), taskId, { files: [{ name: "spät.txt", type: "text/plain", data: bytes("x") }] }, after);
    expect((await getTask(h.db, await p(mitschueler), taskId, after))?.status).toBe("verspaetet");
  });
});

describe("Sortierung", () => {
  it("sortiert Namen deutsch (Schäfer vor Schulz)", () => {
    const names = ["Schulz", "Schäfer", "Öztürk", "Ozan"].sort(new Intl.Collator("de").compare);
    expect(names).toEqual(["Ozan", "Öztürk", "Schäfer", "Schulz"]);
  });
});
