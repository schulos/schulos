import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DbHandle } from "@/core/db/client";
import { auditLog, fileNodes, schoolYears, gebaeudeTicketEvents, gebaeudeTickets, twoFactors } from "@/core/db/schema";
import { loadPermissions } from "@/core/permissions";
import { absenceReports } from "@/modules/abwesenheiten/schema";
import { timetableLessons, timetableSolverRuns, timetableSubstitutions } from "@/modules/stundenplan/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage } from "@/core/files/storage";
import { collectRetention } from "@/core/retention";
import { readZip } from "@/core/zip";
import { MODULES } from "@/modules";
import { buildDataExport, collectPersonalData, EXPORT_NOT_PERSONAL, isActorRef } from "./auskunft";
import { setProfilePhoto } from "./profilbild";
import { userRefs } from "./refs";

describe("Auskunft: Abdeckung", () => {
  it("jede Tabelle mit Personenbezug wird erfasst oder ist begründet ausgenommen", () => {
    const reachable = new Set(["users", ...userRefs().map((r) => r.table)]);
    const declared = new Set(collectRetention(MODULES).map((e) => e.decl.table));
    const missing = [...declared].filter((t) => !reachable.has(t) && !(t in EXPORT_NOT_PERSONAL));
    expect(missing).toEqual([]);
    // Ausnahmen müssen echt sein: Tabellen mit Personenverweis gehören nicht in die Liste
    expect(Object.keys(EXPORT_NOT_PERSONAL).filter((t) => reachable.has(t))).toEqual([]);
    expect(Object.keys(EXPORT_NOT_PERSONAL).filter((t) => !declared.has(t))).toEqual([]);
  });

  it("jedes Modul mit Personenbezug liefert einen Exportteil", () => {
    const reachable = new Set(userRefs().map((r) => r.table));
    for (const m of MODULES) {
      const tables = (m.retention ?? []).map((d) => d.table);
      if (!tables.length) continue;
      expect({ module: m.id, covered: tables.some((t) => reachable.has(t)) }).toEqual({ module: m.id, covered: true });
    }
  });
});

describe("Auskunft (Demo-Schule)", () => {
  let h: DbHandle;
  let dir: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-auskunft-"));
  });
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("sammelt Daten über viele Module, ohne Zugangsgeheimnisse", async () => {
    await h.db.insert(twoFactors).values({ id: "tf-1", userId: "u-jana.brandt", secret: "GEHEIM-TOTP", backupCodes: "GEHEIM-CODES" });
    const data = (await collectPersonalData(h.db, "u-jana.brandt"))!;
    const owners = new Set(data.sections.map((s) => s.owner));
    expect(owners.size).toBeGreaterThanOrEqual(6);
    expect(data.sections.find((s) => s.table === "classbook_entries")!.rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(data.sections);
    expect(text).not.toMatch(/"password"|"token"|GEHEIM/);
    expect(data.sections.find((s) => s.table === "two_factors")!.rows[0]).toHaveProperty("verified", true);
    expect(data.sections.find((s) => s.table === "accounts")!.rows[0]).toHaveProperty("provider_id", "credential");
    expect(await collectPersonalData(h.db, "u-gibt-es-nicht")).toBeNull();

    const lea = (await collectPersonalData(h.db, "u-lea.schaefer"))!;
    expect(lea.sections.map((s) => s.table)).toEqual(expect.arrayContaining(["users", "group_members", "parent_child"]));
  });

  it("ZIP mit Übersicht, JSON je Datenart und eigenen Dateien; protokolliert", async () => {
    const storage = localStorage(dir);
    const key = crypto.randomUUID();
    await storage.put(key, new TextEncoder().encode("Mein Referat"));
    await h.db.insert(fileNodes).values({ kind: "file", name: "Referat Ägypten.txt", ownerId: "u-lea.schaefer", storageKey: key, size: 12, mime: "text/plain" });
    const res = (await buildDataExport(h.db, storage, "u-admin", "u-lea.schaefer", new Date("2026-10-05T10:00:00Z")))!;
    expect(res.filename).toBe("auskunft_lea.schaefer_2026-10-05.zip");
    const files = readZip(res.zip);
    expect(files.has("LIESMICH.txt")).toBe(true);
    const overview = JSON.parse(new TextDecoder().decode(files.get("uebersicht.json")));
    expect(overview.person.name).toBe("Lea Schäfer");
    expect(overview.sections.find((s: { table: string }) => s.table === "users").count).toBe(1);
    expect(files.has("daten/core/users.json")).toBe(true);
    const own = [...files.keys()].find((k) => k.startsWith("dateien/file_nodes/") && k.endsWith("Referat Ägypten.txt"))!;
    expect(new TextDecoder().decode(files.get(own))).toBe("Mein Referat");
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.auskunft"));
    expect(entry).toMatchObject({ actorId: "u-admin", target: "u-lea.schaefer" });
  });
  it("SEC-05: wo die Person nur gehandelt hat, keine Daten oder Dateien Dritter (Verwaltung erfasst Foto und Krankmeldung)", async () => {
    const storage = localStorage(dir);
    const office = await loadPermissions(h.db, "u-sabine.kowalski");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x07, 74, 70, 73, 70, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
    await setProfilePhoto(h.db, storage, office, "u-lea.schaefer", { bytes: jpeg, consent: true, consentOn: "2026-09-01" }, "2026-10-05");
    await h.db.insert(absenceReports).values({
      studentId: "u-lea.schaefer",
      reportedBy: "u-sabine.kowalski",
      decidedBy: "u-sabine.kowalski",
      decidedAt: new Date(),
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
      reason: "krank",
      status: "entschuldigt",
    });

    const data = (await collectPersonalData(h.db, "u-sabine.kowalski"))!;
    expect(data.files.filter((f) => f.path.startsWith("dateien/profile_photos/"))).toEqual([]);
    const photos = data.sections.filter((s) => s.table === "profile_photos");
    expect(photos.map((s) => !!s.asActor)).toEqual([true]);
    expect(Object.keys(photos[0]!.rows[0]!).sort()).toEqual(["consent_by", "created_at", "id"]);
    const absences = data.sections.filter((s) => s.table === "absence_reports");
    expect(absences.map((s) => !!s.asActor)).toEqual([true]);
    expect(JSON.stringify(absences[0]!.rows)).not.toMatch(/krank|u-lea\.schaefer|2026-10-01/);
    const audits = data.sections.find((s) => s.table === "audit_log" && s.asActor)!;
    expect(audits.rows.some((r) => r.action === "profilbild.einwilligung")).toBe(true);
    expect(audits.rows.every((r) => !("target" in r) && !("meta" in r))).toBe(true);

    const res = (await buildDataExport(h.db, storage, "u-admin", "u-sabine.kowalski"))!;
    const zip = readZip(res.zip);
    expect([...zip.keys()].filter((k) => k.startsWith("dateien/"))).toEqual([]);
    expect(zip.has("daten/abwesenheiten/absence_reports.handlungen.json")).toBe(true);
    expect(new TextDecoder().decode(zip.get("daten/core/profile_photos.handlungen.json"))).not.toContain("u-lea.schaefer");

    // Lea selbst bekommt ihr Foto und ihre Abwesenheit vollständig
    const lea = (await collectPersonalData(h.db, "u-lea.schaefer"))!;
    expect(lea.files.some((f) => f.path.startsWith("dateien/profile_photos/") && f.path.endsWith("profilbild.jpg"))).toBe(true);
    expect(JSON.stringify(lea.sections.find((s) => s.table === "absence_reports" && !s.asActor)!.rows)).toContain("krank");
  });

  it("S19: zugewiesene Meldungen erscheinen nur als Handlung – ohne fremden Meldungstext (Security-Review Gate 4a N2)", async () => {
    const [t] = await h.db
      .insert(gebaeudeTickets)
      .values({ year: 2026, seq: 900, category: "gebaeude", priority: "normal", title: "Fenster klemmt", description: "FREITEXT-DER-MELDERIN", location: "Flur", reporterId: "u-jana.brandt", assigneeId: "u-klaus.berger" })
      .returning({ id: gebaeudeTickets.id });
    await h.db.insert(gebaeudeTicketEvents).values([
      { ticketId: t!.id, actorId: "u-klaus.berger", kind: "kommentar", text: "EIGENER-KOMMENTAR" },
      { ticketId: t!.id, actorId: "u-klaus.berger", kind: "zuweisung", text: "zugewiesen an Jana Brandt" },
    ]);
    const data = (await collectPersonalData(h.db, "u-klaus.berger"))!;
    const tickets = data.sections.filter((s) => s.table === "gebaeude_tickets");
    expect(tickets.map((s) => !!s.asActor)).toEqual([true]);
    const text = JSON.stringify(data.sections);
    expect(text).not.toMatch(/FREITEXT-DER-MELDERIN|Fenster klemmt|u-jana\.brandt|Jana Brandt/);
    const events = data.sections.find((s) => s.table === "gebaeude_ticket_events")!;
    expect(events.asActor).toBe(true);
    expect(JSON.stringify(events.rows)).toContain("EIGENER-KOMMENTAR");
    // die meldende Person bekommt ihre Meldung vollständig
    const jana = (await collectPersonalData(h.db, "u-jana.brandt"))!;
    expect(JSON.stringify(jana.sections.find((s) => s.table === "gebaeude_tickets" && !s.asActor)!.rows)).toContain("FREITEXT-DER-MELDERIN");
  });

  it("SP-10: Solver-Läufe nur als Handlung der Planung, Vertretung mit Fachtausch vollständig bei der Vertretung, Rücknahme-Daten nie", async () => {
    const [lesson] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.teacherId, "u-tobias.kleine")).limit(1);
    expect(lesson).toBeTruthy();
    const [sy] = await h.db.select({ id: schoolYears.id }).from(schoolYears).limit(1);
    await h.db.insert(timetableSolverRuns).values({
      id: "run-sp10",
      schoolYearId: sy!.id,
      status: "applied",
      appliedFrom: "2026-11-02",
      createdBy: "u-frank.schulte",
      appliedBy: "u-frank.schulte",
      appliedAt: new Date(),
      label: "VARIANTE-GEHEIM",
      result: { marker: "ERGEBNIS-GEHEIM", teacher: "u-jana.brandt" },
      params: { marker: "PARAMETER-GEHEIM" },
      metrics: { marker: "KENNZAHL-GEHEIM" },
      log: [{ kind: "start", marker: "PROTOKOLL-GEHEIM" }],
      undo: { ended: [{ id: lesson!.id, teacherId: "u-jana.brandt", marker: "UNDO-GEHEIM" }], removed: [] },
    });
    await h.db
      .insert(timetableSubstitutions)
      .values({ id: "sub-sp10", lessonId: lesson!.id, date: "2026-10-05", kind: "substitute", substituteId: "u-jana.brandt", subjectId: lesson!.subjectId, createdBy: "u-frank.schulte" });

    // Planende: nur die Handlung (Zeitpunkte und eigene Spalten), nichts vom Entwurf
    const planer = (await collectPersonalData(h.db, "u-frank.schulte"))!;
    const runs = planer.sections.filter((x) => x.table === "timetable_solver_runs");
    expect(runs.map((x) => x.asActor)).toEqual([true]);
    const runText = JSON.stringify(runs);
    expect(runText).toContain("run-sp10");
    expect(runText).not.toMatch(/GEHEIM|"result"|"params"|"metrics"|"log"|"undo"|"label"/);
    const allowed = new Set(["id", "created_by", "applied_by", "created_at", "finished_at", "heartbeat_at", "applied_at"]);
    expect(Object.keys(runs[0]!.rows[0]!).filter((k) => !allowed.has(k))).toEqual([]);
    // Kategorien im Übersichtsteil nennen die Rücknahme-Daten (Transparenz, DS-Hinweise)
    expect(runs[0]!.categories.join(" ")).toContain("Rücknahme-Daten");

    // Vertretende Lehrkraft: Zeile vollständig mit Fach, aber ohne Solver-Entwurf (kein Verweis auf den Lauf, auch wenn die ID im JSON steht)
    const jana = (await collectPersonalData(h.db, "u-jana.brandt"))!;
    const subs = jana.sections.find((x) => x.table === "timetable_substitutions" && !x.asActor)!;
    expect(subs.rows.find((r) => r.id === "sub-sp10")).toMatchObject({ kind: "substitute", substitute_id: "u-jana.brandt", subject_id: lesson!.subjectId });
    expect(jana.sections.some((x) => x.table === "timetable_solver_runs")).toBe(false);
    expect(JSON.stringify(jana.sections)).not.toMatch(/GEHEIM/);
    // dieselbe Person in der Handlung (Frank hat die Vertretung angelegt): nur Zeitpunkt, kein Fach
    const fSubs = planer.sections.find((x) => x.table === "timetable_substitutions" && x.asActor);
    expect(fSubs?.rows.find((r) => r.id === "sub-sp10")).not.toHaveProperty("subject_id");
  });

  it("Handelnde-Spalten: *_by und actor_id, eigene Inhalte ausgenommen", () => {
    expect(isActorRef({ table: "profile_photos", column: "consent_by" })).toBe(true);
    expect(isActorRef({ table: "audit_log", column: "actor_id" })).toBe(true);
    expect(isActorRef({ table: "absence_reports", column: "decided_by" })).toBe(true);
    expect(isActorRef({ table: "file_nodes", column: "created_by" })).toBe(false);
    expect(isActorRef({ table: "task_files", column: "uploaded_by" })).toBe(false);
    expect(isActorRef({ table: "profile_photos", column: "user_id" })).toBe(false);
    expect(isActorRef({ table: "gebaeude_tickets", column: "assignee_id" })).toBe(true);
    expect(isActorRef({ table: "gebaeude_tickets", column: "reporter_id" })).toBe(false);
    // jede Ausnahme gibt es wirklich
    for (const k of ["file_nodes.created_by", "task_files.uploaded_by", "bookings.booked_by", "parent_letter_receipts.confirmed_by"]) {
      const [table, column] = k.split(".");
      expect(userRefs().some((r) => r.table === table && r.column === column), k).toBe(true);
    }
  });
});
