import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, auditLog, schoolYears, schoolYearTransitions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { readImpressum, saveImpressum } from "@/core/school/impressum";
import { ValidationError } from "@/modules/verwaltung/users";
import { CHECKLIST_KEYS, anmeldungKatalog } from "./katalog";
import { parseFields } from "./labels";
import { pendingAdmissions } from "./uebernahme";
import {
  CHANGED_MEANWHILE,
  acceptsSubmissions,
  addSlots,
  antragNumber,
  canTransition,
  capacitySummary,
  closeVerfahren,
  completeVerfahren,
  createVerfahren,
  deleteSlot,
  deleteVerfahren,
  freeSlots,
  generateSlots,
  getVerfahren,
  insertAntrag,
  listSlots,
  listVerfahren,
  openVerfahren,
  publishVerfahren,
  rejectRetentionFrom,
  requiredRight,
  retentionFromFor,
  setAntragSlot,
  setAntragStatus,
  setChecklist,
  updateVerfahren,
  type AntragData,
} from "./service";

const SABINE = "u-sabine.kowalski"; // Sekretariat (Rolle verwaltung → manage/view)
const PETRA = "u-petra.lindner"; // Schulleitung (Gruppe → decide/view)
const JANA = "u-jana.brandt"; // Lehrkraft, keine Rechte
const YEAR = "sj-2027-28";

const t0 = new Date("2027-01-10T08:00:00Z");
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);

const base = {
  name: "Anmeldung Klasse 5 – Schuljahr 2027/28",
  kind: "klasse5",
  targetSchoolYearId: YEAR,
  targetGradeLevel: 5,
  opensAt: "2027-02-01T08:00",
  closesAt: "2027-02-28T18:00",
  capacity: 3,
  intro: "Bitte bringen Sie den Anmeldeschein mit.",
};

const child = (i: number, extra: Partial<AntragData> = {}): AntragData => ({
  childFirstName: `Kind${i}`,
  childLastName: "Muster",
  childBirthDate: "2016-05-01",
  primarySchool: "GS Am Park",
  parent1Name: `Elternteil ${i}`,
  parent1Email: `eltern${i}@example.org`,
  ...extra,
});

describe("Schulanmeldung – rein", () => {
  it("Slot-Generator: Tage × Zeitfenster × Dauer (+ Pause), Berliner Zeit auch an der Zeitumstellung", () => {
    const slots = generateSlots({ days: ["2027-02-10", "2027-02-11"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 20, parallel: 2 });
    expect(slots).toHaveLength(6);
    expect(slots[0]).toEqual({ startsAt: new Date("2027-02-10T13:00:00Z"), endsAt: new Date("2027-02-10T13:20:00Z"), capacity: 2 });
    const pause = generateSlots({ days: ["2027-02-10"], windows: [{ from: "08:00", to: "09:00" }], durationMinutes: 15, parallel: 1, breakMinutes: 5 });
    expect(pause.map((s) => s.startsAt.toISOString().slice(11, 16))).toEqual(["07:00", "07:20", "07:40"]);
    // Sommerzeit beginnt am 28. 3. 2027
    expect(generateSlots({ days: ["2027-03-28"], windows: [{ from: "10:00", to: "10:30" }], durationMinutes: 30, parallel: 1 })[0]!.startsAt).toEqual(
      new Date("2027-03-28T08:00:00Z"),
    );
  });

  it("Slot-Generator: verständliche Fehler und Obergrenze", () => {
    const err = (spec: Parameters<typeof generateSlots>[0]) => {
      try {
        generateSlots(spec);
      } catch (e) {
        return (e as ValidationError).fieldErrors;
      }
      return null;
    };
    expect(err({ days: [], windows: [{ from: "14:00", to: "13:00" }], durationMinutes: 2, parallel: 0 })).toMatchObject({
      days: expect.any(String),
      windows: expect.any(String),
      durationMinutes: expect.any(String),
      parallel: expect.any(String),
    });
    expect(err({ days: ["2027-02-10"], windows: [{ from: "14:00", to: "14:10" }], durationMinutes: 20, parallel: 1 })).toMatchObject({ durationMinutes: /passt kein/ });
    const many = Array.from({ length: 30 }, (_, i) => `2027-03-${String(i + 1).padStart(2, "0")}`);
    expect(err({ days: many, windows: [{ from: "08:00", to: "18:00" }], durationMinutes: 10, parallel: 1 })).toMatchObject({ days: /Zu viele/ });
    // GATE-4c (Code-M3): kein stilles Rollen in den Folgemonat
    for (const d of ["2027-02-30", "2027-04-31", "2027-13-01", "2027-02-29"])
      expect(err({ days: [d], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 1 }), d).toMatchObject({ days: new RegExp(`Ungültiges Datum: ${d}`) });
    expect(err({ days: ["2028-02-29"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 1 })).toBeNull();
  });

  it("Statusmaschine: Übergänge und Rechte", () => {
    expect(canTransition("eingegangen", "aufgenommen")).toBe(true);
    expect(canTransition("zurueckgezogen", "eingegangen")).toBe(false);
    expect(canTransition("uebernommen", "aufgenommen")).toBe(false);
    expect(canTransition("abgelehnt", "zurueckgezogen")).toBe(false);
    expect(requiredRight("eingegangen", "vollstaendig")).toBe("anmeldung.manage");
    expect(requiredRight("vollstaendig", "aufgenommen")).toBe("anmeldung.decide");
    expect(requiredRight("aufgenommen", "zurueckgezogen")).toBe("anmeldung.decide");
    expect(requiredRight("unbestaetigt", "eingegangen")).toBe("system");
    expect(requiredRight("aufgenommen", "uebernommen")).toBe("system");
  });

  it("Fristbeginn: offene/aufgenommene NULL, zurückgezogen sofort, abgelehnt erst ab Abschluss + Löschfrist", () => {
    const now = new Date("2027-03-01T10:00:00Z");
    const completedAt = new Date("2027-04-01T10:00:00Z");
    const ctx = { now, completedAt: null, rejectKeepDays: 60 };
    expect(retentionFromFor("eingegangen", ctx)).toBeNull();
    expect(retentionFromFor("aufgenommen", ctx)).toBeNull();
    expect(retentionFromFor("abgelehnt", ctx)).toBeNull();
    expect(retentionFromFor("zurueckgezogen", ctx)).toEqual(now);
    expect(retentionFromFor("uebernommen", { ...ctx, transferredAt: completedAt })).toEqual(completedAt);
    // LK-90 löscht 90 Tage nach Fristbeginn → genau 60 Tage nach Abschluss
    const from = rejectRetentionFrom(completedAt, 60);
    expect(retentionFromFor("warteliste", { ...ctx, completedAt })).toEqual(from);
    expect(from.getTime() + 90 * 86_400_000 - completedAt.getTime()).toBe(60 * 86_400_000);
  });

  it("Nummer, Felder, Katalog", () => {
    expect(antragNumber(2027, 42)).toBe("A-2027-0042");
    expect(parseFields(null, "oberstufe_ef")).toEqual({ geschwister: true, zweitwunsch: false, elternteil2: true, hinweise: true });
    expect(parseFields({ zweitwunsch: false, x: true }, "klasse5").zweitwunsch).toBe(false);
    expect(anmeldungKatalog("NW").transitionDoc).toBe("Anmeldeschein");
    expect(anmeldungKatalog("BY").transitionDoc).not.toBe("Anmeldeschein");
    expect(CHECKLIST_KEYS).toEqual(["anmeldeschein", "zeugnis", "geburtsurkunde", "masern"]);
    expect(acceptsSubmissions({ status: "offen", opensAt: day(-1), closesAt: day(1) }, t0)).toBe(true);
    expect(acceptsSubmissions({ status: "offen", opensAt: day(1), closesAt: day(2) }, t0)).toBe(false);
    expect(acceptsSubmissions({ status: "geschlossen", opensAt: day(-1), closesAt: day(1) }, t0)).toBe(false);
  });
});

describe("Schulanmeldung – Datenbank", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let admin: PermissionSet;
  let vid: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.insert(schoolYears).values({ id: YEAR, name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    sabine = await loadPermissions(h.db, SABINE);
    petra = await loadPermissions(h.db, PETRA);
    jana = await loadPermissions(h.db, JANA);
    admin = await loadPermissions(h.db, "u-admin");
  }, 60_000);
  afterAll(() => h.close());

  it("Rechte: Sekretariat bearbeitet, Schulleitung entscheidet und liest, Lehrkräfte nichts", async () => {
    await expect(createVerfahren(h.db, jana, base)).rejects.toThrow(/anmeldung.manage/);
    await expect(createVerfahren(h.db, petra, base)).rejects.toThrow(/anmeldung.manage/);
    await expect(listVerfahren(h.db, jana)).rejects.toThrow(/anmeldung.view/);
    vid = await createVerfahren(h.db, sabine, base, t0);
    expect((await listVerfahren(h.db, petra)).map((v) => v.id)).toContain(vid);
    const v = await getVerfahren(h.db, sabine, vid);
    expect(v).toMatchObject({ status: "entwurf", capacity: 3, rejectKeepDays: 60, schoolYearName: "2027/28", fieldSet: { zweitwunsch: true } });
  });

  it("Verfahren: Prüfung der Eingaben", async () => {
    const bad = createVerfahren(h.db, sabine, { ...base, name: "x", kind: "foo", targetSchoolYearId: "sj-gibts-nicht", targetGradeLevel: 99, closesAt: "2027-01-01T08:00", capacity: "0", rejectKeepDays: 10 });
    await expect(bad).rejects.toMatchObject({
      fieldErrors: {
        name: expect.any(String),
        kind: expect.any(String),
        targetSchoolYearId: expect.stringMatching(/Schuljahr/),
        targetGradeLevel: expect.any(String),
        closesAt: expect.stringMatching(/nach dem Beginn/),
        capacity: expect.any(String),
        rejectKeepDays: expect.any(String),
      },
    });
    // GATE-4c (Code-M3): 30. Februar bzw. 25 Uhr werden nicht still verschoben
    await expect(createVerfahren(h.db, sabine, { ...base, opensAt: "2027-02-30T08:00", closesAt: "2027-03-01T25:00" })).rejects.toMatchObject({
      fieldErrors: { opensAt: /gültiges Datum/, closesAt: /gültiges Datum/ },
    });
  });

  it("Termine: Generator legt an, doppelte Startzeiten werden übersprungen; Veröffentlichen erst mit Terminen", async () => {
    await expect(publishVerfahren(h.db, sabine, vid, t0)).rejects.toMatchObject({ fieldErrors: { verfahren: /Gesprächstermine/ } });
    const spec = { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 };
    expect(await addSlots(h.db, sabine, vid, spec)).toEqual({ added: 2, skipped: 0 });
    expect(await addSlots(h.db, sabine, vid, { ...spec, windows: [{ from: "14:00", to: "16:00" }] })).toEqual({ added: 2, skipped: 2 });
    await expect(addSlots(h.db, sabine, vid, { ...spec, roomId: "gibts-nicht" })).rejects.toMatchObject({ fieldErrors: { roomId: expect.any(String) } });
    expect(await listSlots(h.db, vid)).toHaveLength(4);
    // Q5-22: ohne vollständiges Impressum kein Veröffentlichen
    const imp = await readImpressum(h.db);
    await saveImpressum(h.db, "u-admin", { ...imp.fields, phone: "" });
    await expect(publishVerfahren(h.db, sabine, vid, t0)).rejects.toMatchObject({ fieldErrors: { verfahren: /Impressum ist unvollständig \(fehlt: Telefon\)/ } });
    await saveImpressum(h.db, "u-admin", imp.fields);
    await publishVerfahren(h.db, sabine, vid, t0);
    expect(acceptsSubmissions((await getVerfahren(h.db, sabine, vid))!, day(25))).toBe(true);
    expect((await openVerfahren(h.db, day(25))).map((v) => v.id)).toContain(vid);
    expect((await openVerfahren(h.db, t0)).map((v) => v.id)).not.toContain(vid); // Zeitraum noch nicht begonnen
    // nach dem Veröffentlichen stehen Art und Ziel fest, Text und Zeitraum nicht
    await expect(updateVerfahren(h.db, sabine, vid, { ...base, kind: "seiteneinstieg" })).rejects.toMatchObject({ fieldErrors: { kind: expect.any(String) } });
    await updateVerfahren(h.db, sabine, vid, { ...base, intro: "Neuer Text" });
    expect((await getVerfahren(h.db, sabine, vid))!.intro).toBe("Neuer Text");
  });

  it("Anträge: Nummer je Zieljahr, Termin-Plätze begrenzt, unbestätigte haben Fristbeginn als Rückfallebene", async () => {
    const [s1] = await listSlots(h.db, vid);
    const a1 = await insertAntrag(h.db, vid, child(1, { slotId: s1!.id }), { now: day(25) });
    const a2 = await insertAntrag(h.db, vid, child(2, { slotId: s1!.id }), { now: day(25) });
    expect([a1.number, a2.number]).toEqual(["A-2027-0001", "A-2027-0002"]);
    await expect(insertAntrag(h.db, vid, child(3, { slotId: s1!.id }), { now: day(25) })).rejects.toMatchObject({ fieldErrors: { slotId: /ausgebucht/ } });
    const [row] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, a1.id));
    expect(row).toMatchObject({ status: "unbestaetigt", retentionFrom: day(25), confirmedAt: null });
    expect((await freeSlots(h.db, vid, day(25))).map((s) => s.id)).not.toContain(s1!.id);
    await expect(deleteSlot(h.db, sabine, s1!.id)).rejects.toMatchObject({ fieldErrors: { slot: /gebucht/ } });
  });

  it("Statusmaschine in der DB: Bestätigung (System), Termin, Unterlagen, Entscheidung nur mit decide, Verlauf + Audit", async () => {
    const slots = await listSlots(h.db, vid);
    const { id } = await insertAntrag(h.db, vid, child(4), { now: day(25) });
    // Sekretariat darf nicht „bestätigen“ – das macht nur der Link
    await expect(setAntragStatus(h.db, sabine, id, "eingegangen")).rejects.toThrow(/nur automatisch/);
    await setAntragStatus(h.db, null, id, "eingegangen", { now: day(25) });
    let [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id));
    expect(a).toMatchObject({ status: "eingegangen", retentionFrom: null, confirmedAt: day(25) });
    await expect(setAntragStatus(h.db, sabine, id, "termin")).rejects.toMatchObject({ fieldErrors: { status: /Gesprächstermin/ } });
    await setAntragSlot(h.db, sabine, id, slots[1]!.id, day(26));
    [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id));
    expect(a!.status).toBe("termin");
    // Unterlagen: erst alle Häkchen → vollständig; eines weg → zurück auf „termin“
    expect(await setChecklist(h.db, sabine, id, { anmeldeschein: true, zeugnis: true }, CHECKLIST_KEYS, day(30))).toBe("termin");
    expect(await setChecklist(h.db, sabine, id, Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])), CHECKLIST_KEYS, day(30))).toBe("vollstaendig");
    expect(await setChecklist(h.db, sabine, id, { anmeldeschein: true }, CHECKLIST_KEYS, day(30))).toBe("termin");
    await setChecklist(h.db, sabine, id, Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])), CHECKLIST_KEYS, day(30));
    // Entscheidung: nicht durch das Sekretariat
    await expect(setAntragStatus(h.db, sabine, id, "aufgenommen")).rejects.toThrow(/anmeldung.decide/);
    await setAntragStatus(h.db, petra, id, "aufgenommen", { now: day(40), note: "Geschwisterkind" });
    [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id));
    expect(a).toMatchObject({ status: "aufgenommen", decidedBy: PETRA, decidedAt: day(40), decisionNote: "Geschwisterkind", retentionFrom: null });
    // unzulässiger Übergang
    await expect(setAntragStatus(h.db, petra, id, "eingegangen")).rejects.toMatchObject({ fieldErrors: { status: /nicht nach/ } });
    // Eltern ziehen über den Link nur offene Anträge zurück
    await expect(setAntragStatus(h.db, null, id, "zurueckgezogen")).rejects.toMatchObject({ fieldErrors: { status: /entschieden/ } });
    const events = await h.db.select().from(anmeldungEreignisse).where(eq(anmeldungEreignisse.antragId, id));
    expect(events.map((e) => e.text)).toContain("Unterlagen vollständig → Aufgenommen");
    const logged = await h.db.select().from(auditLog).where(eq(auditLog.target, id));
    expect(logged.map((l) => l.action)).toContain("anmeldung.antrag.status");
    expect(JSON.stringify(logged)).not.toContain("Muster");
  });

  it("GATE-4c (Code-M2): Rücknahme ↔ Entscheidung ↔ Checkliste gleichzeitig – genau ein Übergang gewinnt, nichts wird still überschrieben", async () => {
    const v2 = await createVerfahren(h.db, sabine, { ...base, name: "Konflikte" }, t0);
    const fresh = async (i: number) => {
      const { id } = await insertAntrag(h.db, v2, child(50 + i), { now: day(25) });
      await setAntragStatus(h.db, null, id, "eingegangen", { now: day(25) });
      return id;
    };
    const statusOf = async (id: string) => (await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id)))[0]!.status;
    // Eltern ziehen zurück, während die Schulleitung aufnimmt
    const id1 = await fresh(1);
    const race = await Promise.allSettled([setAntragStatus(h.db, null, id1, "zurueckgezogen", { now: day(41) }), setAntragStatus(h.db, petra, id1, "aufgenommen", { now: day(41) })]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ValidationError);
    const won = race[0]!.status === "fulfilled" ? "zurueckgezogen" : "aufgenommen";
    expect(await statusOf(id1)).toBe(won);
    // Checkliste gleichzeitig mit der Entscheidung: die Entscheidung wird nie auf „vollständig“ zurückgesetzt
    const id2 = await fresh(2);
    const all = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true]));
    const race2 = await Promise.allSettled([setChecklist(h.db, sabine, id2, all, CHECKLIST_KEYS, day(42)), setAntragStatus(h.db, petra, id2, "abgelehnt", { now: day(42) })]);
    // je nach Reihenfolge: Entscheidung gilt (dann bleibt sie) oder sie scheitert mit Hinweis – nie „entschieden, aber vollständig“
    if (race2[1]!.status === "fulfilled") expect(await statusOf(id2)).toBe("abgelehnt");
    else expect([(race2[1] as PromiseRejectedResult).reason, await statusOf(id2)]).toEqual([expect.any(ValidationError), "vollstaendig"]);
    // Entscheidung als Liste: der gesehene Stand ist inzwischen ein anderer → Hinweis statt Überschreiben
    const id3 = await fresh(3);
    await setAntragStatus(h.db, null, id3, "zurueckgezogen", { now: day(43) });
    await expect(setAntragStatus(h.db, petra, id3, "warteliste", { from: "eingegangen" })).rejects.toMatchObject({ fieldErrors: { status: CHANGED_MEANWHILE } });
    expect(await statusOf(id3)).toBe("zurueckgezogen");
  });

  it("Kapazität nur zur Information; Abschluss erst nach allen Entscheidungen, dann Löschfrist für Abgelehnte", async () => {
    const ids = [];
    for (let i = 10; i < 14; i++) {
      const { id } = await insertAntrag(h.db, vid, child(i), { now: day(25) });
      await setAntragStatus(h.db, null, id, "eingegangen", { now: day(25) });
      ids.push(id);
    }
    // drei aufnehmen (Kapazität 3), einer schon von oben → 4 aufgenommen: Hinweis, keine Sperre
    for (const id of ids.slice(0, 3)) await setAntragStatus(h.db, petra, id, "aufgenommen", { now: day(40) });
    const cap = await capacitySummary(h.db, vid);
    expect(cap).toMatchObject({ capacity: 3, free: -1 });
    expect(cap.byStatus.aufgenommen).toBe(4);

    await expect(completeVerfahren(h.db, petra, vid, day(50))).rejects.toMatchObject({ fieldErrors: { verfahren: /schließen/ } });
    await closeVerfahren(h.db, sabine, vid, day(45));
    await expect(completeVerfahren(h.db, sabine, vid, day(50))).rejects.toThrow(/anmeldung.decide/);
    await expect(completeVerfahren(h.db, petra, vid, day(50))).rejects.toMatchObject({ fieldErrors: { verfahren: /ohne Entscheidung/ } });
    await setAntragStatus(h.db, petra, ids[3]!, "abgelehnt", { now: day(48) });
    let [rej] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids[3]!));
    expect(rej!.retentionFrom).toBeNull(); // Widerspruchsfrist läuft erst ab Abschluss
    // übrige Altlasten aus den Tests oben (unbestätigte) zählen nicht als offen
    await completeVerfahren(h.db, petra, vid, day(50));
    [rej] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids[3]!));
    expect(rej!.retentionFrom).toEqual(rejectRetentionFrom(day(50), 60));
    // abgeschlossen: keine Änderungen mehr außer der Übernahme
    await expect(setAntragStatus(h.db, petra, ids[0]!, "warteliste")).rejects.toMatchObject({ fieldErrors: { status: /abgeschlossen/ } });
    await expect(setAntragStatus(h.db, admin, ids[0]!, "uebernommen")).rejects.toThrow(/nur automatisch/);
    await setAntragStatus(h.db, null, ids[0]!, "uebernommen", { now: day(200), transferredUserId: "u-lea.schaefer" });
    const [moved] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids[0]!));
    expect(moved).toMatchObject({ status: "uebernommen", transferredAt: day(200), retentionFrom: day(200) });
    await expect(updateVerfahren(h.db, sabine, vid, base)).rejects.toMatchObject({ fieldErrors: { verfahren: /Abgeschlossene/ } });
  });

  it("Löschlauf: abgelehnter Antrag erscheint 60 Tage nach Abschluss in der Vorschau, offene nie", async () => {
    const due = async (ymd: string) => (await planDeletion(h.db, ymd)).find((p) => p.table === "anmeldung_antraege")!;
    // Abschluss day(50) = 2027-03-01; + 60 Tage = 2027-04-30
    const before = await due("2027-04-29");
    const after = await due("2027-05-01");
    expect(after.status).toBe("due");
    expect(after.count).toBeGreaterThan(before.count);
  });

  it("Q5-19: Nachrücken nach Abschluss bis Schuljahresbeginn – Fristbeginn neu, Löschvorschau, Neuaufnahmen", async () => {
    const v3 = await createVerfahren(h.db, sabine, { ...base, name: "Nachrücken" }, t0);
    await addSlots(h.db, sabine, v3, { days: ["2027-02-12"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 1 });
    await publishVerfahren(h.db, sabine, v3, t0);
    const ids: string[] = [];
    for (let i = 70; i < 73; i++) {
      const { id } = await insertAntrag(h.db, v3, child(i), { now: day(25) });
      await setAntragStatus(h.db, null, id, "eingegangen", { now: day(25) });
      await setAntragStatus(h.db, petra, id, i === 72 ? "abgelehnt" : "warteliste", { now: day(40) });
      ids.push(id);
    }
    await closeVerfahren(h.db, sabine, v3, day(45));
    await completeVerfahren(h.db, petra, v3, day(50));
    const [wait, wait2, rejected] = ids as [string, string, string];
    const row = async (id: string) => (await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, id)))[0]!;
    expect((await row(wait)).retentionFrom).toEqual(rejectRetentionFrom(day(50), 60));
    const due = async () => (await planDeletion(h.db, "2027-05-01")).find((p) => p.table === "anmeldung_antraege")!.count;
    const before = await due();
    // nur Schulleitung, nur warteliste → aufgenommen
    await expect(setAntragStatus(h.db, sabine, wait, "aufgenommen", { now: day(60) })).rejects.toThrow(/anmeldung.decide/);
    await expect(setAntragStatus(h.db, petra, rejected, "aufgenommen", { now: day(60) })).rejects.toMatchObject({ fieldErrors: { status: /abgeschlossen/ } });
    await expect(setAntragStatus(h.db, petra, wait, "abgelehnt", { now: day(60) })).rejects.toMatchObject({ fieldErrors: { status: /abgeschlossen/ } });
    // ab Schuljahresbeginn (1. 8. 2027, Berliner Datum) nicht mehr
    await expect(setAntragStatus(h.db, petra, wait2, "aufgenommen", { now: new Date("2027-07-31T22:30:00Z") })).rejects.toMatchObject({
      fieldErrors: { status: /Beginn des Schuljahres \(01\.08\.2027\)/ },
    });
    await setAntragStatus(h.db, petra, wait, "aufgenommen", { now: new Date("2027-07-31T21:30:00Z") });
    expect(await row(wait)).toMatchObject({ status: "aufgenommen", retentionFrom: null, decidedBy: PETRA });
    // Fristbeginn neu: der Nachgerückte fällt aus der Löschvorschau, die anderen bleiben drin
    expect(await due()).toBe(before - 1);
    expect((await row(wait2)).retentionFrom).toEqual(rejectRetentionFrom(day(50), 60));
    const events = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, wait), eq(anmeldungEreignisse.kind, "status")));
    expect(events.map((e) => e.text)).toContain("Warteliste → Aufgenommen (Nachrücken nach Abschluss)");
    expect((await h.db.select().from(auditLog).where(eq(auditLog.target, wait))).map((l) => l.meta)).toContainEqual({ von: "warteliste", nach: "aufgenommen", nachruecken: true });
    // Kind landet im nächsten Schuljahreswechsel im Schritt „Neuaufnahmen“
    const pending = (await pendingAdmissions(h.db, YEAR)).map((c) => c.antragId);
    expect(pending).toContain(wait);
    expect(pending).not.toContain(wait2);
    // sind die Neuaufnahmen für das Zieljahr schon übernommen, ginge das Kind verloren → gesperrt
    const [cur] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [t] = await h.db.insert(schoolYearTransitions).values({ fromYearId: cur!.id, toYearId: YEAR, admittedAt: day(100) }).returning();
    await expect(setAntragStatus(h.db, petra, wait2, "aufgenommen", { now: day(110) })).rejects.toMatchObject({ fieldErrors: { status: /schon übernommen/ } });
    await h.db.delete(schoolYearTransitions).where(eq(schoolYearTransitions.id, t!.id));
  });

  it("Verfahren löschen nur als Entwurf ohne Anträge", async () => {
    await expect(deleteVerfahren(h.db, sabine, vid)).rejects.toBeInstanceOf(ValidationError);
    const draft = await createVerfahren(h.db, sabine, { ...base, name: "Seiteneinstieg 2027/28", kind: "seiteneinstieg" }, t0);
    await deleteVerfahren(h.db, sabine, draft);
    expect(await getVerfahren(h.db, sabine, draft)).toBeNull();
  });
});
