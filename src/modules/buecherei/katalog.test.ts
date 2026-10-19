// Schulbücherei – Katalog, Vormerkung, „Meine Ausleihen“ (BU-03, SICHERHEIT S75): Verfügbarkeit ohne Personen, Vormerken nur bei
// ganz ausgeliehenen Titeln, Nachrücken mit Gong (ohne Titel), Theke gibt Bereitgelegtes nur an die vormerkende Person, kein
// Verlängern bei Vormerkung, Eltern lesen die Ausleihen ihrer Kinder, kein Verlauf.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiCopies, buechereiReservations, notifications } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { catalogTitle, childrenLibrary, libraryAuskunft, libraryText, myLibrary, searchCatalog } from "./katalog";
import { checkin, checkout, dueDate, renewLoan, renewOwnLoan } from "./loans";
import { cancelReservation, reserve, runReservations } from "./reservations";
import { buechereiSearch } from "./search";
import { createTitle } from "./service";
import { HOLD_DAYS, MAX_RESERVATIONS } from "./settings";

const TODAY = "2026-10-19";
const SABINE = "u-sabine.kowalski"; // Verwaltung: Theke und Bestand
const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin 7b
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea

const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && Object.values(e.fieldErrors).some((m) => re.test(m)));

describe("Bücherei – Katalog und Vormerkung", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let titleId: string;
  let copies: string[];
  let other: string; // eine weitere Schülerin/ein weiterer Schüler

  beforeAll(async () => {
    h = await createSeededTestDb();
    const { id, barcodes } = await createTitle(h.db, await p(SABINE), { title: "Vormerkbuch", author: "Ria Reihe", keywords: "Warteschlange", mediaType: "buch" }, { count: 2 });
    titleId = id;
    copies = barcodes;
    const hits = await (await import("./loans")).searchBorrowers(h.db, await p(SABINE), "7b");
    other = hits.find((x) => x.id !== LEA)!.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it("S75: Katalog nur mit `buecherei.use` – Verfügbarkeit ohne Personen; Eltern und Konten ohne Recht nicht", async () => {
    const lea = await p(LEA);
    const hits = await searchCatalog(h.db, lea, { q: "warteschlange ria" });
    expect(hits).toEqual([expect.objectContaining({ id: titleId, title: "Vormerkbuch", active: 2, free: 2, shelf: 2, waiting: 0, ready: 0 })]);
    expect(JSON.stringify(await searchCatalog(h.db, lea))).not.toMatch(/u-[a-z]+\.[a-z]+/); // keine Konten
    // Demo: ausgesondertes Exemplar zählt nicht, Titel ohne Bestand fehlen
    expect((await searchCatalog(h.db, lea, { q: "Leuchtturm" }))[0]).toMatchObject({ active: 2 });
    await expect(searchCatalog(h.db, await p(MUTTER))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(catalogTitle(h.db, await p(MUTTER), titleId)).rejects.toBeInstanceOf(ForbiddenError);
    // alle Rollen außer Eltern und Admin dürfen ausleihen (Projektleitung 2026-10-19)
    for (const id of [JANA, SABINE]) expect((await searchCatalog(h.db, await p(id), { q: "Vormerkbuch" })).length).toBe(1);
    // globale Suche
    const current = { user: { id: LEA } as never, perms: lea };
    expect((await buechereiSearch.search(h.db, current, "Vormerk"))[0]).toMatchObject({ href: `/buecherei/katalog/${titleId}`, subtitle: expect.stringContaining("2 verfügbar") });
    expect(await buechereiSearch.search(h.db, { user: { id: MUTTER } as never, perms: await p(MUTTER) }, "Vormerk")).toEqual([]);
  });

  it("Vormerken nur, wenn kein Exemplar im Regal steht; nicht für den eigenen geliehenen Titel; Reihenfolge", async () => {
    const lea = await p(LEA);
    await fails(reserve(h.db, lea, titleId), /steht im Regal/);
    const desk = await p(SABINE);
    await checkout(h.db, desk, other, copies[0]!, TODAY);
    await checkout(h.db, desk, JANA, copies[1]!, TODAY);
    await fails(reserve(h.db, await p(JANA), titleId), /gerade ausgeliehen/);
    expect(await reserve(h.db, lea, titleId)).toEqual({ title: "Vormerkbuch", position: 1 });
    await fails(reserve(h.db, lea, titleId), /Schon vorgemerkt/);
    expect((await reserve(h.db, await p(SABINE), titleId)).position).toBe(2);
    await expect(reserve(h.db, await p(MUTTER), titleId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reserve(h.db, await p("u-admin"), titleId)).rejects.toBeInstanceOf(ForbiddenError);
    const t = await catalogTitle(h.db, lea, titleId);
    expect(t).toMatchObject({ reservation: { position: 1, readyOn: null }, canReserve: false, availability: { free: 0, waiting: 2 } });
    expect(JSON.stringify(t)).not.toContain(other);
    // Höchstzahl je Person
    await writeModuleSetting(h.db, MAX_RESERVATIONS, "0");
    await fails(reserve(h.db, await p(other), titleId), /ausgeschaltet/);
    await writeModuleSetting(h.db, MAX_RESERVATIONS, "5");
  });

  it("Kein Verlängern bei Vormerkung – an der Theke und selbst", async () => {
    const mine = await myLibrary(h.db, await p(JANA), TODAY);
    const loan = mine.loans.find((l) => l.titleId === titleId)!;
    expect(loan.renewBlock).toMatch(/Vorgemerkt/);
    await fails(renewLoan(h.db, await p(SABINE), loan.id, TODAY), /Vorgemerkt/);
    await fails(renewOwnLoan(h.db, await p(JANA), loan.id, TODAY), /Vorgemerkt/);
    // fremde Ausleihe selbst verlängern: gibt es nicht
    await fails(renewOwnLoan(h.db, await p(LEA), loan.id, TODAY), /gibt es nicht/);
    await expect(renewOwnLoan(h.db, await p(MUTTER), loan.id, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Rückgabe → erste Vormerkung bereit mit Abholfrist und Gong ohne Titel; Theke gibt es nur an sie", async () => {
    const desk = await p(SABINE);
    await checkin(h.db, desk, copies[0]!, TODAY);
    const [r] = await h.db.select().from(buechereiReservations).where(and(eq(buechereiReservations.titleId, titleId), eq(buechereiReservations.userId, LEA)));
    expect(r).toMatchObject({ readyOn: TODAY, holdUntil: await dueDate(h.db, TODAY, 7) });
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, LEA), eq(notifications.moduleId, "buecherei")));
    expect(gong).toHaveLength(1);
    expect(`${gong[0]!.title} ${gong[0]!.body}`).not.toContain("Vormerkbuch");
    // die zweite Vormerkung wartet weiter
    expect((await myLibrary(h.db, desk, TODAY)).reservations[0]).toMatchObject({ position: 1, readyOn: null });
    expect((await catalogTitle(h.db, await p(other), titleId))!.availability).toMatchObject({ free: 1, ready: 1, shelf: 0 });
    // an eine andere Person nicht – ohne Namen
    await fails(checkout(h.db, desk, other, copies[0]!, TODAY), /liegt für eine andere Person bereit$/);
    // an Lea: Vormerkung erfüllt und gelöscht
    await checkout(h.db, desk, LEA, copies[0]!, TODAY);
    expect(await h.db.select().from(buechereiReservations).where(eq(buechereiReservations.userId, LEA))).toEqual([]);
  });

  it("Löschen einer bereiten Vormerkung und abgelaufene Abholfrist lassen die nächste nachrücken", async () => {
    const desk = await p(SABINE);
    await writeModuleSetting(h.db, HOLD_DAYS, "3");
    await checkin(h.db, desk, copies[1]!, TODAY); // Jana gibt zurück → Sabines Vormerkung bereit
    const sab = (await myLibrary(h.db, desk, TODAY)).reservations[0]!;
    expect(sab.readyOn).toBe(TODAY);
    expect((await reserve(h.db, await p(other), titleId)).position).toBe(1); // das freie Exemplar liegt für Sabine bereit → vormerkbar
    await expect(cancelReservation(h.db, await p(LEA), sab.id, TODAY)).rejects.toBeInstanceOf(ValidationError); // fremde
    await cancelReservation(h.db, desk, sab.id, TODAY);
    const [next] = await h.db.select().from(buechereiReservations).where(eq(buechereiReservations.titleId, titleId));
    expect(next).toMatchObject({ userId: other, readyOn: TODAY, holdUntil: await dueDate(h.db, TODAY, 3) });
    // Frist abgelaufen: täglicher Lauf löscht und benachrichtigt
    const r = await runReservations(h.db, addDays(next!.holdUntil!, 1));
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await h.db.select().from(buechereiReservations).where(eq(buechereiReservations.titleId, titleId))).toEqual([]);
    const gong = await h.db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, other));
    expect(gong.map((g) => g.title)).toContain("Vormerkung verfallen");
    await writeModuleSetting(h.db, HOLD_DAYS, "7");
  });

  it("Meine Ausleihen nur Aktuelles; Eltern lesen die ihrer Kinder; Auskunft und Eigenexport", async () => {
    const lea = await myLibrary(h.db, await p(LEA), TODAY);
    expect(lea.loans.map((l) => l.title)).toContain("Vormerkbuch");
    const kids = await childrenLibrary(h.db, await p(MUTTER), TODAY);
    expect(kids.find((k) => k.id === LEA)!.loans.map((l) => l.title)).toContain("Vormerkbuch");
    expect(await childrenLibrary(h.db, await p(JANA), TODAY)).toEqual([]);
    await expect(myLibrary(h.db, await p(MUTTER), TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    // nach Rückgabe ohne Befund: nichts mehr – kein Verlauf
    const [c] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, copies[0]!));
    await checkin(h.db, await p(SABINE), c!.barcode, TODAY);
    expect((await myLibrary(h.db, await p(LEA), TODAY)).loans.some((l) => l.titleId === titleId)).toBe(false);
    // Auskunft/Eigenexport: Demo-Vormerkung des Films (Seed) erscheint lesbar
    const [demo] = await h.db.select({ userId: buechereiReservations.userId }).from(buechereiReservations);
    const data = await libraryAuskunft(h.db, demo!.userId);
    expect(data.reservations[0]).toMatchObject({ titel: "Reise zum Mond (Dokumentation)" });
    expect(libraryText(data)).toContain("Vorgemerkt:\n- Reise zum Mond (Dokumentation)");
    expect(libraryText({ loans: [], reservations: [] })).toBeNull();
  });
});
