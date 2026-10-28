import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { hilfePages, notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { listNotifications } from "@/core/notifications";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { helpHref } from "./context";
import { hilfeSearch } from "./search";
import {
  addMonths,
  createPage,
  createSection,
  deletePage,
  deleteSection,
  dueForReview,
  getPage,
  listOutline,
  markReviewed,
  moveSection,
  runReviewReminders,
  searchPages,
  slugify,
  STAFF_TARGET_ROLES,
  updatePage,
  type PageInput,
} from "./service";
import { REVIEW_MONTHS } from "./settings";

describe("Handbuch: reine Helfer", () => {
  it("slugify: Umlaute, Sonderzeichen, Länge, leer", () => {
    expect(slugify("Zwei-Faktor einrichten")).toBe("zwei-faktor-einrichten");
    expect(slugify("Größe & Übergänge für Schüler:innen")).toBe("groesse-uebergaenge-fuer-schueler-innen");
    expect(slugify("  ?!  ")).toBe("seite");
    expect(slugify("a".repeat(80)).length).toBe(60);
  });

  it("„?“ in der Kopfzeile führt ins Handbuch, mit Zuordnung (HB-07) auf die Seite des Moduls", () => {
    expect(helpHref("/")).toBe("/hilfe");
    expect(helpHref("/news/abc")).toBe("/hilfe");
    expect(helpHref("/abwesenheiten/melden", { abwesenheiten: "krankmeldung" })).toBe("/hilfe/krankmeldung");
  });

  it("addMonths schneidet am Monatsende ab und geht über Jahresgrenzen", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 12)).toBe("2027-11-15");
    expect(addMonths("2026-03-15", -12)).toBe("2025-03-15");
    expect(addMonths("2026-01-10", -1)).toBe("2025-12-10");
  });
});

describe("Handbuch (Demo-Schule)", () => {
  let h: DbHandle;
  let mutter: string;
  let fremdesKind: string;
  let sectionId: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const input = (over: Partial<PageInput> = {}): PageInput => ({
    sectionId,
    title: "Testseite",
    body: "Inhalt",
    status: "veroeffentlicht",
    contactId: null,
    targetRoles: [],
    targetGroupIds: [],
    ...over,
  });
  const slugsFor = async (id: string) => (await listOutline(h.db, await p(id))).flatMap((s) => s.pages.map((x) => x.slug));

  beforeAll(async () => {
    h = await createSeededTestDb();
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    fremdesKind = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    sectionId = await createSection(h.db, await p("u-sabine.kowalski"), "Testbereich");
  }, 60_000);
  afterAll(() => h.close());

  it("Rechte: Verwaltung pflegt (hilfe.edit), Lehrkraft und Schülerin nicht; Löschen nur mit hilfe.manage", async () => {
    const lk = await p("u-jana.brandt");
    await expect(createSection(h.db, lk, "x")).rejects.toThrow(ForbiddenError);
    await expect(createPage(h.db, lk, input())).rejects.toThrow(ForbiddenError);
    await expect(createPage(h.db, await p("u-lea.schaefer"), input())).rejects.toThrow(ForbiddenError);
    const slug = await createPage(h.db, await p("u-sabine.kowalski"), input({ title: "Rechte-Test" }));
    expect(slug).toBe("rechte-test");
    const page = (await getPage(h.db, lk, slug))!;
    await expect(deletePage(h.db, lk, page.id)).rejects.toThrow(ForbiddenError);
    await deletePage(h.db, await p("u-sabine.kowalski"), page.id);
    expect(await getPage(h.db, await p("u-sabine.kowalski"), slug)).toBeNull();
  });

  it("Adressen sind eindeutig und meiden reservierte Pfade", async () => {
    const sek = await p("u-sabine.kowalski");
    expect(await createPage(h.db, sek, input({ title: "Doppelt" }))).toBe("doppelt");
    expect(await createPage(h.db, sek, input({ title: "Doppelt" }))).toBe("doppelt-2");
    expect(await createPage(h.db, sek, input({ title: "Neu" }))).toBe("neu-2");
  });

  it("validiert Titel, Bereich und Ansprechperson (nur aktives Personal)", async () => {
    const sek = await p("u-sabine.kowalski");
    await expect(createPage(h.db, sek, input({ title: " " }))).rejects.toThrow(ValidationError);
    await expect(createPage(h.db, sek, input({ sectionId: "gibts-nicht" }))).rejects.toThrow(ValidationError);
    await expect(createPage(h.db, sek, input({ contactId: "u-lea.schaefer" }))).rejects.toThrow(ValidationError);
    await expect(createPage(h.db, sek, input({ targetGroupIds: ["g-gibts-nicht"] }))).rejects.toThrow(ValidationError);
  });

  it("Zielgruppen: Personal-Seite, Klassen-Seite (Eltern über ihr Kind), Seite für alle, Entwurf", async () => {
    const sek = await p("u-sabine.kowalski");
    await createPage(h.db, sek, input({ title: "Nur Personal", targetRoles: STAFF_TARGET_ROLES }));
    await createPage(h.db, sek, input({ title: "Für die 7b", targetGroupIds: ["g-7b"] }));
    await createPage(h.db, sek, input({ title: "Für Eltern", targetRoles: ["eltern"] }));
    await createPage(h.db, sek, input({ title: "Für alle" }));
    await createPage(h.db, sek, input({ title: "Noch Entwurf", status: "entwurf", contactId: "u-frank.schulte" }));

    const lea = await slugsFor("u-lea.schaefer");
    expect(lea).toEqual(expect.arrayContaining(["fuer-die-7b", "fuer-alle", "fundsachen"]));
    expect(lea).not.toContain("nur-personal");
    expect(lea).not.toContain("fuer-eltern");
    expect(lea).not.toContain("kopierer-im-lehrerzimmer");

    const eltern = await slugsFor(mutter);
    expect(eltern).toEqual(expect.arrayContaining(["fuer-die-7b", "fuer-eltern", "fuer-alle"]));
    expect(eltern).not.toContain("nur-personal");

    const fremd = await slugsFor(fremdesKind);
    expect(fremd).toContain("fuer-alle");
    expect(fremd).not.toContain("fuer-die-7b");

    const lk = await slugsFor("u-jana.brandt");
    expect(lk).toEqual(expect.arrayContaining(["nur-personal", "kopierer-im-lehrerzimmer", "fuer-alle"]));
    expect(lk).not.toContain("noch-entwurf");
    expect(lk).not.toContain("fuer-eltern");

    // Entwurf: Pflegende und die Ansprechperson
    expect(await slugsFor("u-sabine.kowalski")).toContain("noch-entwurf");
    expect(await slugsFor("u-frank.schulte")).toContain("noch-entwurf");
    expect(await getPage(h.db, await p(mutter), "noch-entwurf")).toBeNull();
    expect(await getPage(h.db, await p(mutter), "nur-personal")).toBeNull();
    expect((await getPage(h.db, await p(mutter), "fuer-die-7b"))?.title).toBe("Für die 7b");
  });

  it("Gliederung: leere Bereiche nur für Pflegende", async () => {
    const empty = await createSection(h.db, await p("u-sabine.kowalski"), "Leerer Bereich");
    expect((await listOutline(h.db, await p("u-sabine.kowalski"))).map((s) => s.id)).toContain(empty);
    expect((await listOutline(h.db, await p("u-jana.brandt"))).map((s) => s.id)).not.toContain(empty);
    await moveSection(h.db, await p("u-sabine.kowalski"), empty, -1);
    const order = (await listOutline(h.db, await p("u-sabine.kowalski"))).map((s) => s.id);
    expect(order.indexOf(empty)).toBeLessThan(order.indexOf(sectionId));
    await expect(deleteSection(h.db, await p("u-sabine.kowalski"), sectionId)).rejects.toThrow(ValidationError);
    await expect(deleteSection(h.db, await p("u-jana.brandt"), empty)).rejects.toThrow(ForbiddenError);
    await deleteSection(h.db, await p("u-sabine.kowalski"), empty);
  });

  it("Ansprechperson bearbeitet nur die eigene Seite – Titel und Text, nicht Zielgruppen oder Status", async () => {
    const sek = await p("u-sabine.kowalski");
    await createPage(h.db, sek, input({ title: "Franks Seite", contactId: "u-frank.schulte", targetRoles: STAFF_TARGET_ROLES }));
    const frank = await p("u-frank.schulte");
    const page = (await getPage(h.db, frank, "franks-seite"))!;
    await updatePage(h.db, frank, page.id, input({ title: "Franks Seite (neu)", body: "Neuer Text", status: "entwurf", targetRoles: [], contactId: null }), "2030-02-01");
    const after = (await getPage(h.db, sek, "franks-seite"))!;
    expect(after).toMatchObject({ title: "Franks Seite (neu)", body: "Neuer Text", status: "veroeffentlicht", contactId: "u-frank.schulte", reviewedOn: "2030-02-01" });
    expect(after.targetRoles.sort()).toEqual([...STAFF_TARGET_ROLES].sort());
    // fremde Seite: nein
    const other = (await getPage(h.db, frank, "nur-personal"))!;
    await expect(updatePage(h.db, frank, other.id, input({ title: "gehackt" }))).rejects.toThrow(ForbiddenError);
    await expect(markReviewed(h.db, frank, other.id)).rejects.toThrow(ForbiddenError);
    await expect(updatePage(h.db, await p("u-jana.brandt"), page.id, input({ title: "gehackt" }))).rejects.toThrow(ForbiddenError);
  });

  it("Suche findet nur Sichtbares (Volltext mit Stammform und Teilwort im Titel)", async () => {
    const sek = await p("u-sabine.kowalski");
    await createPage(h.db, sek, input({ title: "Schlüsselausgabe", body: "Die Hausmeisterei gibt Schlüssel gegen Unterschrift aus.", targetRoles: STAFF_TARGET_ROLES }));
    await createPage(h.db, sek, input({ title: "Elternsprechtage", body: "Termine buchen Eltern online.", targetRoles: ["eltern"] }));
    const hits = async (id: string, q: string) => (await searchPages(h.db, await p(id), q)).map((x) => x.slug);
    expect(await hits("u-jana.brandt", "Unterschriften")).toEqual(["schluesselausgabe"]);
    expect(await hits(mutter, "Unterschriften")).toEqual([]);
    expect(await hits(mutter, "Termin")).toEqual(["elternsprechtage"]);
    expect(await hits("u-jana.brandt", "Termin")).toEqual([]);
    expect(await hits("u-jana.brandt", "schlüssel")).toEqual(["schluesselausgabe"]);
    expect(await hits(mutter, "50%_")).toEqual([]);
    // globale Suche (Strg+K): Gruppe „Handbuch“
    const global = await hilfeSearch.search(h.db, { perms: await p(mutter) } as never, "Termin");
    expect(global).toEqual([expect.objectContaining({ group: "Handbuch", href: "/hilfe/elternsprechtage" })]);
  });

  it("Erinnerung: fällig nach der Frist genau einmal an die Ansprechperson; Prüfen setzt zurück; abschaltbar", async () => {
    const sek = await p("u-sabine.kowalski");
    const slug = await createPage(h.db, sek, input({ title: "Erinnerungsseite", contactId: "u-jana.brandt", targetRoles: STAFF_TARGET_ROLES }), "2030-03-10");
    const id = (await getPage(h.db, sek, slug))!.id;
    const gongs = async () => (await listNotifications(h.db, "u-jana.brandt", 100)).filter((n) => n.href === `/hilfe/${slug}`);

    await runReviewReminders(h.db, new Date("2031-03-09T08:00:00Z"));
    expect(await gongs()).toHaveLength(0);
    expect((await dueForReview(h.db, await p("u-jana.brandt"), "2031-03-09")).map((d) => d.slug)).not.toContain(slug);

    await runReviewReminders(h.db, new Date("2031-03-10T08:00:00Z"));
    expect(await gongs()).toEqual([expect.objectContaining({ title: "Überprüfung fällig: Erinnerungsseite" })]);
    await runReviewReminders(h.db, new Date("2031-03-11T08:00:00Z"));
    await runReviewReminders(h.db, new Date("2031-06-11T08:00:00Z"));
    expect(await gongs()).toHaveLength(1);
    // Widget: Ansprechperson sieht die eigene, Pflegende alle; Fälligkeit nach 12 Monaten
    expect(await dueForReview(h.db, await p("u-jana.brandt"), "2031-03-10")).toEqual([expect.objectContaining({ slug, dueOn: "2031-03-10" })]);
    expect((await dueForReview(h.db, sek, "2031-03-10", 50)).map((d) => d.slug)).toContain(slug);
    expect(await dueForReview(h.db, await p("u-frank.schulte"), "2031-03-10")).toEqual(expect.not.arrayContaining([expect.objectContaining({ slug })]));

    // „Geprüft, unverändert“ → neue Frist, wieder genau eine Erinnerung
    await markReviewed(h.db, await p("u-jana.brandt"), id, "2031-03-12");
    await runReviewReminders(h.db, new Date("2032-03-11T08:00:00Z"));
    expect(await gongs()).toHaveLength(1);
    await runReviewReminders(h.db, new Date("2032-03-12T08:00:00Z"));
    expect(await gongs()).toHaveLength(2);

    // abschaltbar (Moduleinstellung „aus“)
    await markReviewed(h.db, sek, id, "2032-04-01");
    await writeModuleSetting(h.db, REVIEW_MONTHS, "0");
    expect(await runReviewReminders(h.db, new Date("2040-01-01T08:00:00Z"))).toBe(0);
    expect(await dueForReview(h.db, sek, "2040-01-01")).toEqual([]);
    expect(await gongs()).toHaveLength(2);
    await writeModuleSetting(h.db, REVIEW_MONTHS, "12");
  });

  it("Entwürfe und Seiten ohne Ansprechperson lösen keinen Gong aus", async () => {
    const sek = await p("u-sabine.kowalski");
    const draft = await createPage(h.db, sek, input({ title: "Entwurf mit Kontakt", status: "entwurf", contactId: "u-frank.schulte" }), "2030-01-01");
    const orphan = await createPage(h.db, sek, input({ title: "Ohne Ansprechperson" }), "2030-01-01");
    await runReviewReminders(h.db, new Date("2045-01-01T08:00:00Z"));
    const sent = await h.db.select({ href: notifications.href }).from(notifications).where(eq(notifications.moduleId, "hilfe"));
    expect(sent.map((n) => n.href)).not.toContain(`/hilfe/${draft}`);
    expect(sent.map((n) => n.href)).not.toContain(`/hilfe/${orphan}`);
    // ohne Ansprechperson: im Widget der Pflegenden sichtbar
    expect((await dueForReview(h.db, sek, "2045-01-01", 100)).map((d) => d.slug)).toContain(orphan);
  });

  it("Kontolöschung: Seite bleibt, Ansprechperson und Bearbeiter:in werden geleert; Auskunft enthält die Seite", async () => {
    const lk = (await listUsers(h.db, { role: "lehrkraft" })).rows.find((u) => !["u-jana.brandt", "u-frank.schulte"].includes(u.id))!.id;
    const sek = await p("u-sabine.kowalski");
    const slug = await createPage(h.db, sek, input({ title: "Seite einer Lehrkraft", contactId: lk }));
    const id = (await getPage(h.db, sek, slug))!.id;
    await updatePage(h.db, await p(lk), id, input({ title: "Seite einer Lehrkraft", body: "von ihr geändert" }));

    const data = await collectPersonalData(h.db, lk);
    const section = data!.sections.find((s) => s.table === "hilfe_pages" && !s.asActor);
    expect(section?.rows.map((r) => r.title)).toContain("Seite einer Lehrkraft");

    await deleteAccounts(h.db, [lk]);
    expect(await h.db.select().from(users).where(eq(users.id, lk))).toEqual([]);
    const [row] = await h.db.select().from(hilfePages).where(eq(hilfePages.id, id));
    expect(row).toMatchObject({ title: "Seite einer Lehrkraft", body: "von ihr geändert", contactId: null, updatedBy: null });
  });
});
