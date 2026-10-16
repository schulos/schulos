import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { MailMessage } from "@schulos/server/mail";
import type { DbHandle } from "@/core/db/client";
import { bookingResources, bookings, gebaeudeTicketPhotos, gebaeudeTickets, groupMembers, groups, notifications, timetableLessons, timetableRoomBlocks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { JPEG_64x48, PNG } from "@/core/images.fixtures";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { affectedLessons } from "@/modules/stundenplan/raumsperren";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  addComment,
  addPhotos,
  assignTicket,
  blockRoomFromTicket,
  canTransition,
  changeStatus,
  createTicket,
  dangerMessage,
  getTicket,
  listResponsibilities,
  listTickets,
  MAX_DANGER_ALARMS_PER_HOUR,
  MAX_TICKETS_PER_HOUR,
  openSummary,
  photoFor,
  searchTickets,
  setResponsibility,
  ticketBlock,
  TICKET_STATUSES,
  TRANSITIONS,
  type TicketInput,
} from "./service";

const JANA = "u-jana.brandt";
const KLAUS = "u-klaus.berger"; // Rolle personal, Gruppe Hausmeisterei (gebaeude.manage)
const SABINE = "u-sabine.kowalski"; // Rolle verwaltung
const LEA = "u-lea.schaefer";
const NOW = new Date("2030-03-04T09:00:00Z");
const MO = "2026-10-05";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

const input = (over: Partial<TicketInput> = {}): TicketInput => ({
  category: "technik",
  priority: "normal",
  roomId: "112",
  location: null,
  title: "Beamer defekt",
  description: "Bild flackert und geht aus.",
  photos: [],
  ...over,
});

describe("Gebäude & Technik – Status-Maschine (rein)", () => {
  it("nur erlaubte Übergänge; abgeschlossene lassen sich wieder öffnen", () => {
    expect(canTransition("neu", "angenommen")).toBe(true);
    expect(canTransition("neu", "wartet_extern")).toBe(false);
    expect(canTransition("wartet_extern", "abgelehnt")).toBe(false);
    expect(canTransition("erledigt", "in_arbeit")).toBe(true);
    expect(canTransition("abgelehnt", "neu")).toBe(true);
    expect(canTransition("erledigt", "abgelehnt")).toBe(false);
    // kein Status geht in sich selbst über, jeder Status ist erreichbar
    for (const s of TICKET_STATUSES) expect(TRANSITIONS[s]).not.toContain(s);
    const reachable = new Set(Object.values(TRANSITIONS).flat());
    expect(TICKET_STATUSES.filter((s) => s !== "neu" && !reachable.has(s))).toEqual([]);
  });

  it("Alarm-Mail ohne Personennamen", () => {
    const m = dangerMessage("SchulOS Lindenhof", ["it@schule.de"], { number: "M-2030-0001", category: "sicherheit", place: "Raum 112", title: "Steckdose offen" });
    expect(m.subject).toContain("Gefahr gemeldet");
    expect(m.text).toContain("Raum 112");
    expect(m.text).not.toMatch(/Brandt|gemeldet von/);
  });
});

describe("Gebäude & Technik – Service", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const p = (id: string) => loadPermissions(h.db, id);
  const gongs = async (userId: string) => (await h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "gebaeude")))).map((n) => n.title);

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-gebaeude-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Rechte: Lehrkraft und Personal melden, Schüler:innen nicht (Q-21); Hausmeister bearbeitet über die Gruppe", async () => {
    const [jana, klaus, lea] = await Promise.all([p(JANA), p(KLAUS), p(LEA)]);
    expect(klaus.role).toBe("personal");
    expect(jana.granted.has("gebaeude.report")).toBe(true);
    expect(klaus.granted.has("gebaeude.report") && klaus.granted.has("gebaeude.manage")).toBe(true);
    expect(jana.granted.has("gebaeude.manage")).toBe(false);
    await expect(createTicket(h.db, storage, lea, input())).rejects.toThrow(ForbiddenError);
  });

  it("Melden: laufende Nummer je Jahr, Gong an die Hausmeisterei, nicht an die meldende Person", async () => {
    const jana = await p(JANA);
    const a = await createTicket(h.db, storage, jana, input(), { now: NOW });
    const b = await createTicket(h.db, storage, jana, input({ title: "Fenster klemmt", roomId: null, location: "Flur 2. OG" }), { now: NOW });
    expect(a.number).toBe("M-2030-0001");
    expect(b.number).toBe("M-2030-0002");
    expect(await gongs(KLAUS)).toContain("Neue Meldung: Beamer defekt");
    expect(await gongs(JANA)).toEqual([]);
    // Verwaltung bekommt bei normaler Priorität keinen Gong (Zuständigkeit: Hausmeisterei)
    expect(await gongs(SABINE)).toEqual([]);
  });

  it("Eingaben prüfen: Raum oder Ort, Kategorie, Titel", async () => {
    const jana = await p(JANA);
    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ roomId: null, location: "" })))).toHaveProperty("roomId");
    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ roomId: "gibtsnicht" })))).toHaveProperty("roomId");
    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ category: "kaffee" })))).toHaveProperty("category");
    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ title: "x" })))).toHaveProperty("title");
  });

  it("Fotos: Metadaten weg, höchstens drei, nur JPEG/PNG/WebP, höchstens 5 MB (Q-24)", async () => {
    const jana = await p(JANA);
    const { id } = await createTicket(h.db, storage, jana, input({ title: "Tafel gesprungen", photos: [JPEG_64x48] }));
    const [photo] = await h.db.select().from(gebaeudeTicketPhotos).where(eq(gebaeudeTicketPhotos.ticketId, id));
    expect(photo).toMatchObject({ mime: "image/jpeg", width: 64, height: 48, createdBy: JANA });
    const stored = new Uint8Array(await new Response((await storage.get(photo!.storageKey))!).arrayBuffer());
    expect(String.fromCharCode(...stored)).not.toContain("Exif");
    expect(stored.length).toBe(photo!.size);

    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ photos: [PNG, PNG, PNG, PNG] })))).toHaveProperty("photos");
    const gif = new TextEncoder().encode("GIF89a........");
    expect((await fieldErrors(createTicket(h.db, storage, jana, input({ photos: [gif] })))).photos).toMatch(/JPEG, PNG oder WebP/);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await fieldErrors(createTicket(h.db, storage, jana, input({ photos: [big] })))).photos).toMatch(/5 MB/);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await fieldErrors(createTicket(h.db, storage, jana, input({ photos: [svg] })))).toHaveProperty("photos");

    // nachreichen bis drei
    expect(await addPhotos(h.db, storage, jana, id, [PNG, PNG])).toBe(2);
    expect(await fieldErrors(addPhotos(h.db, storage, jana, id, [PNG]))).toHaveProperty("photos");
    // Foto nur für Berechtigte
    const other = await p("u-benedikt.lange");
    expect(await photoFor(h.db, other, photo!.id)).toBeNull();
    expect(await photoFor(h.db, jana, photo!.id)).not.toBeNull();
    expect(await photoFor(h.db, await p(KLAUS), photo!.id)).not.toBeNull();
    await expect(addPhotos(h.db, storage, other, id, [PNG])).rejects.toThrow(ForbiddenError);
  });

  it("Sichtbarkeit: Melder:in sieht nur eigene Meldungen, Hausmeisterei und Verwaltung alle", async () => {
    const [jana, other, klaus, sabine] = await Promise.all([p(JANA), p("u-benedikt.lange"), p(KLAUS), p(SABINE)]);
    const { id } = await createTicket(h.db, storage, jana, input({ title: "Waschbecken tropft" }));
    expect(await getTicket(h.db, other, id)).toBeNull();
    expect((await listTickets(h.db, other)).map((t) => t.id)).not.toContain(id);
    expect((await listTickets(h.db, jana)).every((t) => t.reporterId === JANA)).toBe(true);
    expect((await getTicket(h.db, jana, id))!.transitions).toEqual([]);
    expect((await getTicket(h.db, klaus, id))!.transitions).toContain("angenommen");
    expect((await listTickets(h.db, sabine)).map((t) => t.id)).toContain(id);
    expect((await searchTickets(h.db, other, "Waschbecken")).length).toBe(0);
    expect((await searchTickets(h.db, klaus, "Waschbecken")).map((t) => t.id)).toEqual([id]);
  });

  it("Status: nur „manage“, nur erlaubte Übergänge; Annehmen weist zu, Gong an Melder:in, Abschluss setzt closed_at", async () => {
    const [jana, klaus] = await Promise.all([p(JANA), p(KLAUS)]);
    const { id } = await createTicket(h.db, storage, jana, input({ title: "Tür schließt nicht" }));
    await expect(changeStatus(h.db, jana, id, "erledigt")).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(changeStatus(h.db, klaus, id, "wartet_extern"))).toHaveProperty("status");
    await changeStatus(h.db, klaus, id, "angenommen");
    let t = (await getTicket(h.db, klaus, id))!.ticket;
    expect(t).toMatchObject({ status: "angenommen", assigneeId: KLAUS, closedAt: null });
    expect(await gongs(JANA)).toContain("Deine Meldung: Angenommen");
    await changeStatus(h.db, klaus, id, "erledigt", { comment: "Schließer getauscht" });
    t = (await getTicket(h.db, klaus, id))!.ticket;
    expect(t.closedAt).not.toBeNull();
    expect((await listTickets(h.db, klaus)).map((x) => x.id)).not.toContain(id);
    expect((await listTickets(h.db, klaus, { state: "closed" })).map((x) => x.id)).toContain(id);
    await changeStatus(h.db, klaus, id, "in_arbeit");
    expect((await getTicket(h.db, klaus, id))!.ticket.closedAt).toBeNull();
    const events = (await getTicket(h.db, jana, id))!.events;
    expect(events.map((e) => e.statusTo)).toEqual(["neu", "angenommen", "erledigt", "in_arbeit"]);
    expect(events.find((e) => e.statusTo === "erledigt")?.text).toBe("Schließer getauscht");
  });

  it("Kommentare und Zuweisung: Gong an die andere Seite; zuweisen nur an Personen mit „manage“", async () => {
    const [jana, klaus, other] = await Promise.all([p(JANA), p(KLAUS), p("u-benedikt.lange")]);
    const { id } = await createTicket(h.db, storage, jana, input({ title: "Rollo hängt" }));
    await expect(addComment(h.db, other, id, "Ich auch")).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(assignTicket(h.db, klaus, id, JANA))).toHaveProperty("assigneeId");
    await assignTicket(h.db, klaus, id, SABINE);
    expect(await gongs(SABINE)).toContain("Dir zugewiesen: Rollo hängt");
    await addComment(h.db, jana, id, "Betrifft das linke Fenster");
    expect(await gongs(SABINE)).toContain("Kommentar zu " + (await getTicket(h.db, jana, id))!.ticket.number);
    await addComment(h.db, klaus, id, "Ersatzteil bestellt");
    expect((await gongs(JANA)).filter((g) => g.startsWith("Kommentar zu")).length).toBe(1);
    const kinds = (await getTicket(h.db, jana, id))!.events.map((e) => e.kind);
    expect(kinds).toEqual(["status", "zuweisung", "kommentar", "kommentar"]);
  });

  it("Zuständigkeit je Kategorie (Q-22): IT-Gruppe bekommt IT-Meldungen; einstellen nur mit „configure“", async () => {
    const [jana, klaus, sabine] = await Promise.all([p(JANA), p(KLAUS), p(SABINE)]);
    await h.db.insert(groups).values({ id: "g-it", name: "IT/Medien", slug: "it-medien", kind: "frei" });
    await h.db.insert(groupMembers).values({ groupId: "g-it", userId: "u-benedikt.lange" });
    await expect(setResponsibility(h.db, klaus, "it", "g-it")).rejects.toThrow(ForbiddenError);
    await setResponsibility(h.db, sabine, "it", "g-it");
    await createTicket(h.db, storage, jana, input({ category: "it", title: "WLAN weg" }));
    expect(await gongs("u-benedikt.lange")).toContain("Neue Meldung: WLAN weg");
    expect(await gongs(KLAUS)).not.toContain("Neue Meldung: WLAN weg");
    // ohne Eintrag gilt die Gruppe der Kategorie „gebaeude“ (Hausmeisterei)
    await setResponsibility(h.db, sabine, "reinigung", null);
    await createTicket(h.db, storage, jana, input({ category: "reinigung", title: "Klassenraum nicht gereinigt" }));
    expect(await gongs(KLAUS)).toContain("Neue Meldung: Klassenraum nicht gereinigt");
  });

  it("Gefahr: zusätzlich Gong an die Verwaltung und Alarm-Mail (nur mit SMTP); Mail-Fehler stoppen das Melden nicht", async () => {
    const jana = await p(JANA);
    const sent: MailMessage[] = [];
    const config = { host: "smtp", port: 587, secure: false, user: null, password: null, from: "a@b.de", to: ["hausmeister@schule.de"] };
    await createTicket(h.db, storage, jana, input({ priority: "gefahr", category: "sicherheit", title: "Steckdose offen" }), { mail: { config, sender: async (m) => void sent.push(m) } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["hausmeister@schule.de"]);
    expect(sent[0]!.text).not.toContain("Brandt");
    expect(await gongs(SABINE)).toContain("Gefahr: Steckdose offen");
    // ohne SMTP keine Mail, mit kaputtem Versand trotzdem gespeichert
    await createTicket(h.db, storage, jana, input({ priority: "gefahr", title: "Glasbruch" }), { mail: { config: null } });
    const failing = createTicket(h.db, storage, jana, input({ priority: "gefahr", title: "Kabel lose" }), {
      mail: {
        config,
        sender: async () => {
          throw new Error("SMTP weg");
        },
      },
    });
    await expect(failing).resolves.toMatchObject({ number: expect.stringMatching(/^M-\d{4}-\d{4}$/) });
    expect((await openSummary(h.db)).danger).toBeGreaterThanOrEqual(3);
  });

  it("Drossel (Security-Review Gate 4a N3): höchstens 20 Meldungen je Stunde, Gefahr-Alarm höchstens dreimal", async () => {
    const other = await p("u-benedikt.lange");
    const at = new Date("2031-05-05T08:00:00Z");
    const sent: MailMessage[] = [];
    const config = { host: "smtp", port: 587, secure: false, user: null, password: null, from: "a@b.de", to: ["hausmeister@schule.de"] };
    const mail = { config, sender: async (m: MailMessage) => void sent.push(m) };
    const alarms: boolean[] = [];
    for (let i = 0; i < MAX_DANGER_ALARMS_PER_HOUR + 2; i++)
      alarms.push((await createTicket(h.db, storage, other, input({ priority: "gefahr", title: `Gefahr ${i}` }), { now: at, mail })).alarm);
    expect(alarms).toEqual([true, true, true, false, false]);
    expect(sent).toHaveLength(MAX_DANGER_ALARMS_PER_HOUR);
    // gespeichert und an die Zuständigen gemeldet wird trotzdem
    expect(await gongs(KLAUS)).toContain(`Gefahr: Gefahr ${MAX_DANGER_ALARMS_PER_HOUR + 1}`);
    expect(await gongs(SABINE)).not.toContain(`Gefahr: Gefahr ${MAX_DANGER_ALARMS_PER_HOUR + 1}`);
    for (let i = MAX_DANGER_ALARMS_PER_HOUR + 2; i < MAX_TICKETS_PER_HOUR; i++) await createTicket(h.db, storage, other, input({ title: `Meldung ${i}` }), { now: at });
    expect((await fieldErrors(createTicket(h.db, storage, other, input({ title: "eine zu viel" }), { now: at }))).title).toMatch(/Zu viele Meldungen/);
    // eine Stunde später geht es wieder; interne Meldungen (Prüfungen) sind ausgenommen
    await createTicket(h.db, storage, other, input({ title: "später" }), { now: new Date(at.getTime() + 3_600_001) });
    await createTicket(h.db, storage, other, input({ title: "aus Prüfung" }), { now: at, rateLimit: false });
  });

  it("Fotos nachreichen ist atomar: parallele Uploads überschreiten die Grenze nicht", async () => {
    const jana = await p(JANA);
    const { id } = await createTicket(h.db, storage, jana, input({ title: "Parallel-Fotos" }));
    const results = await Promise.allSettled([addPhotos(h.db, storage, jana, id, [PNG, PNG]), addPhotos(h.db, storage, jana, id, [PNG, PNG])]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await h.db.select().from(gebaeudeTicketPhotos).where(eq(gebaeudeTicketPhotos.ticketId, id));
    expect(rows.length).toBe(2);
  });

  it("Schüler:in mit Melderecht (z. B. SV) sieht keine Namen der Bearbeitung (S25, Security-Review Gate 4a Hinweis 5)", async () => {
    const klaus = await p(KLAUS);
    const lea = { ...(await p(LEA)), granted: new Set(["gebaeude.report"]) };
    const { id } = await createTicket(h.db, storage, lea, input({ title: "Tisch wackelt" }));
    await changeStatus(h.db, klaus, id, "angenommen");
    await assignTicket(h.db, klaus, id, SABINE);
    const d = (await getTicket(h.db, lea, id))!;
    expect(d.ticket.assigneeName).toBe("Schulpersonal");
    expect((await listTickets(h.db, lea)).find((t) => t.id === id)?.assigneeName).toBe("Schulpersonal");
    expect(d.ticket.reporterName).toBe("Lea Schäfer");
    expect(JSON.stringify(d.events)).not.toMatch(/Klaus|Berger|Sabine|Kowalski/);
    expect((await getTicket(h.db, await p(JANA), id))).toBeNull();
    expect(JSON.stringify((await getTicket(h.db, klaus, id))!.events)).toContain("Sabine");
  });

  it("Zuständigkeit: keine Gruppen mit Schüler:innen; unveränderte (auch archivierte) Gruppe bleibt beim Speichern", async () => {
    const sabine = await p(SABINE);
    const [klasse] = await h.db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "klasse")).limit(1);
    expect(await fieldErrors(setResponsibility(h.db, sabine, "sonstiges", klasse!.id))).toHaveProperty("group-sonstiges");
    await h.db.insert(groups).values({ id: "g-moebel", name: "Möbel-AG", slug: "moebel-ag", kind: "frei" });
    await setResponsibility(h.db, sabine, "sonstiges", "g-moebel");
    await h.db.update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, "g-moebel"));
    await setResponsibility(h.db, sabine, "sonstiges", "g-moebel");
    expect((await listResponsibilities(h.db)).find((r) => r.category === "sonstiges")?.groupId).toBe("g-moebel");
  });

  it("Raumsperre aus der Meldung (P4-14): Grund „defekt“, Vertretungsbedarf, Hinweis auf Buchungen, Ende bei „erledigt“", async () => {
    const [jana, klaus] = await Promise.all([p(JANA), p(KLAUS)]);
    const lessons = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.weekday, 0), eq(timetableLessons.week, "all")));
    const roomId = lessons.find((l) => l.roomId && l.roomId !== "112" && l.roomId !== "NW2")!.roomId!;
    const { id } = await createTicket(h.db, storage, jana, input({ roomId, title: "Beamer defekt" }));
    await expect(blockRoomFromTicket(h.db, jana, id, { startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null }, MO)).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(blockRoomFromTicket(h.db, klaus, id, { startsOn: "2026-10-01", endsOn: "2026-10-02", fromPeriod: null, toPeriod: null }, MO))).toHaveProperty("endsOn");
    // Buchung im Zeitraum (Raum buchbar machen) → Hinweis, keine Blockade
    const [res] = await h.db.insert(bookingResources).values({ kind: "room", roomId, name: `Raum ${roomId}` }).onConflictDoNothing().returning({ id: bookingResources.id });
    const resourceId = res?.id ?? (await h.db.select({ id: bookingResources.id }).from(bookingResources).where(eq(bookingResources.roomId, roomId)))[0]!.id;
    await h.db.insert(bookings).values({ resourceId, date: MO, periodNr: 7, bookedBy: JANA });

    const blockId = await blockRoomFromTicket(h.db, klaus, id, { startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null }, MO);
    const [block] = await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, blockId));
    expect(block).toMatchObject({ roomId, reason: "defekt", startsOn: MO, endsOn: MO });
    expect(block!.note).toMatch(/^M-\d{4}-\d{4}: Beamer defekt/);
    const detail = (await getTicket(h.db, klaus, id))!;
    expect(detail.ticket.roomBlockId).toBe(blockId);
    expect(detail.events.at(-1)).toMatchObject({ kind: "raumsperre" });
    expect((await affectedLessons(h.db, MO, 1)).some((a) => a.roomId === roomId && a.block.id === blockId)).toBe(true);
    const info = (await ticketBlock(h.db, klaus, blockId, MO))!;
    expect(info.active).toBe(true);
    expect(info.bookings).toEqual([expect.objectContaining({ date: MO, periodNr: 7, byName: "Jana Brandt" })]);
    // Melder:in sieht die Sperre, aber nicht, wer gebucht hat (Security-Review Gate 4a N4 / Code-Review N7)
    const asReporter = (await ticketBlock(h.db, jana, blockId, MO))!;
    expect(asReporter.active).toBe(true);
    expect(asReporter.bookings).toEqual([]);
    // zweite Sperre für dieselbe Meldung nicht
    expect(await fieldErrors(blockRoomFromTicket(h.db, klaus, id, { startsOn: MO, endsOn: MO, fromPeriod: 1, toPeriod: 2 }, MO))).toHaveProperty("startsOn");
    // Meldung ohne Raum: keine Sperre
    const { id: noRoom } = await createTicket(h.db, storage, jana, input({ roomId: null, location: "Pausenhof" }));
    expect(await fieldErrors(blockRoomFromTicket(h.db, klaus, noRoom, { startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null }, MO))).toHaveProperty("roomId");

    // erledigt mit „Sperre beenden“: Sperre ab heute weg (beginnt heute → gelöscht), Verweis fällt weg
    await changeStatus(h.db, klaus, id, "erledigt", { endBlock: true, todayYmd: MO });
    expect(await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, blockId))).toEqual([]);
    expect((await getTicket(h.db, klaus, id))!.ticket.roomBlockId).toBeNull();
    expect((await affectedLessons(h.db, MO, 1)).some((a) => a.block.id === blockId)).toBe(false);
  });

  it("mehrtägige Sperre wird bei „erledigt“ gekürzt, nicht gelöscht", async () => {
    const [jana, klaus] = await Promise.all([p(JANA), p(KLAUS)]);
    const { id } = await createTicket(h.db, storage, jana, input({ roomId: "NW2", title: "Abzug läuft nicht" }));
    const blockId = await blockRoomFromTicket(h.db, klaus, id, { startsOn: MO, endsOn: "2026-10-09", fromPeriod: 3, toPeriod: 4 }, MO);
    await changeStatus(h.db, klaus, id, "erledigt", { endBlock: true, todayYmd: "2026-10-07" });
    const [block] = await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, blockId));
    expect(block).toMatchObject({ startsOn: MO, endsOn: "2026-10-06", fromPeriod: 3, toPeriod: 4 });
  });

  it("Löschfrist: abgeschlossene Meldungen ein Jahr nach Abschluss, offene bleiben (LK-ENDE-1J ab closed_at)", async () => {
    const jana = await p(JANA);
    const old = new Date("2024-01-10T10:00:00Z");
    const open = await createTicket(h.db, storage, jana, input({ title: "Uralt offen" }), { now: old });
    const closed = await createTicket(h.db, storage, jana, input({ title: "Uralt erledigt" }), { now: old });
    await h.db.update(gebaeudeTickets).set({ status: "erledigt", closedAt: old }).where(eq(gebaeudeTickets.id, closed.id));
    const item = (await planDeletion(h.db, "2026-10-10")).find((i) => i.table === "gebaeude_tickets")!;
    expect(item.status).toBe("due");
    expect(item.count).toBe(1);
    expect(open.id).not.toBe(closed.id);
  });
});
