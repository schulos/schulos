// Schulbücherei Stufe 2 – Lernmittel (BU-10): Schalter, Rechte, Prüfungen, Inventarnummern im eigenen Nummernkreis, Zustand,
// Aussondern/Archivieren, Bücherliste je Jahrgang (Freigabe, Eltern-Vorauswahl), Etiketten-Baustein, kein Personenbezug.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiBooklists, buechereiMaterialCopies, buechereiTeachingMaterials } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { NO_PERSONAL_DATA } from "@/core/retention";
import { ValidationError } from "@/modules/verwaltung/users";
import { copyNumber, formatEuro, gradeRange, isValidCopyNumber, materialNumber, parseEuro } from "./labels";
import {
  addMaterialCopies,
  booklist,
  booklistOverview,
  createMaterial,
  deleteMaterial,
  getMaterial,
  lernmittelEnabled,
  listMaterials,
  materialLabels,
  materialsSummary,
  ownGrades,
  publishedGrades,
  restoreMaterialCopy,
  saveBooklist,
  setMaterialArchived,
  updateMaterial,
  updateMaterialCopy,
  withdrawMaterialCopy,
} from "./lernmittel";
import { scanAtDesk } from "./loans";
import { LERNMITTEL } from "./settings";

const TODAY = "2026-10-20";
const SABINE = "u-sabine.kowalski"; // Verwaltung: `buecherei.materials`
const AYLIN = "u-aylin.demir"; // Leitung Büchereiteam: Theke + Bestand, keine Lernmittel
const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin 7b
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea

const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && re.test(Object.values(e.fieldErrors).join(" | ")));

describe("Lernmittel – reine Helfer", () => {
  it("Inventarnummer mit eigenem Präfix und Prüfziffer", () => {
    expect(materialNumber(42)).toMatch(/^L-000042-\d$/);
    expect(isValidCopyNumber(materialNumber(42))).toBe(true);
    expect(materialNumber(42).slice(2)).toBe(copyNumber(42).slice(2));
  });

  it("Preis in Euro lesen und zeigen", () => {
    expect(parseEuro("24,50")).toBe(2450);
    expect(parseEuro("24.5")).toBe(2450);
    expect(parseEuro("12 €")).toBe(1200);
    expect(parseEuro("")).toBeNull();
    expect(parseEuro("abc")).toBe("bad");
    expect(parseEuro("1000")).toBe("bad");
    expect(formatEuro(1095)).toBe("10,95 €");
  });

  it("Jahrgänge kompakt", () => {
    expect(gradeRange([7, 5, 6])).toBe("5–7");
    expect(gradeRange([5, 7])).toBe("5, 7");
    expect(gradeRange([5])).toBe("5");
  });
});

describe("Lernmittel – Pflege und Bücherliste", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it("Schalter `buecherei.lernmittel`: ab Werk aus, aus → keine Pflege und keine Bücherliste", async () => {
    expect(LERNMITTEL.default).toBe("0");
    expect(await lernmittelEnabled(h.db)).toBe(true); // Demo schaltet ein
    await writeModuleSetting(h.db, LERNMITTEL, "0");
    try {
      await fails(listMaterials(h.db, await p(SABINE)), /ausgeschaltet/);
      await fails(createMaterial(h.db, await p(SABINE), { title: "X", grades: [5], provision: "leihe" }), /ausgeschaltet/);
      await fails(booklist(h.db, await p(LEA), 5), /ausgeschaltet/);
    } finally {
      await writeModuleSetting(h.db, LERNMITTEL, "1");
    }
  });

  it("S81: Pflege nur mit `buecherei.materials` – Büchereiteam, Lehrkraft, Schüler:in und Eltern nicht", async () => {
    expect((await materialsSummary(h.db, await p(SABINE))).materials).toBeGreaterThan(5);
    for (const who of [AYLIN, JANA, LEA, MUTTER]) {
      await expect(listMaterials(h.db, await p(who))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createMaterial(h.db, await p(who), { title: "X", grades: [5], provision: "leihe" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(saveBooklist(h.db, await p(who), 5, { text: "x", published: true })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(materialLabels(h.db, await p(who), { materialId: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("Prüfungen: Titel, ISBN, Jahrgang, Fach, Preis, Dublette; Kauf ohne Exemplare", async () => {
    const s = await p(SABINE);
    await fails(createMaterial(h.db, s, { title: " ", grades: [5], provision: "leihe" }), /Titel/);
    await fails(createMaterial(h.db, s, { title: "A", isbn: "978-3-00-000011-0", grades: [5], provision: "leihe" }), /ISBN/);
    await fails(createMaterial(h.db, s, { title: "A", grades: [], provision: "leihe" }), /Jahrgang/);
    await fails(createMaterial(h.db, s, { title: "A", grades: ["99"], provision: "leihe" }), /unbekannter Jahrgang/);
    await fails(createMaterial(h.db, s, { title: "A", grades: [5], subjectId: "XX", provision: "leihe" }), /Fach/);
    await fails(createMaterial(h.db, s, { title: "A", grades: [5], provision: "schenken" }), /Ausleihe oder Kauf/);
    await fails(createMaterial(h.db, s, { title: "A", grades: [5], provision: "kauf", price: "zwölf" }), /Preis/);
    await fails(createMaterial(h.db, s, { title: "A", isbn: "9783000000119", grades: [6], provision: "leihe" }), /gehört schon zu „Wortwerkstatt Deutsch 5“/);
    await fails(createMaterial(h.db, s, { title: "A", grades: [5], provision: "kauf" }, { count: 3 }), /Selbstkaufen/);
  });

  it("Exemplare: eigener Nummernkreis `L-`, Zustand mit Vermerk, aussondern, zurückholen; Löschen nur ohne Exemplare", async () => {
    const s = await p(SABINE);
    const { id, numbers } = await createMaterial(
      h.db,
      s,
      { title: "Klangwelten 5/6", publisher: "Lindenblatt", subjectId: "MU", grades: ["6", "5", "5"], provision: "leihe", price: "19,90" },
      { count: 3, acquiredYear: 2026 },
    );
    expect(numbers).toHaveLength(3);
    expect(numbers.every((n) => /^L-\d{6}-\d$/.test(n) && isValidCopyNumber(n))).toBe(true);
    const more = await addMaterialCopies(h.db, s, id, { count: 2, condition: "gut" });
    expect(Number(more[0]!.split("-")[1])).toBe(Number(numbers[2]!.split("-")[1]) + 1);
    const data = await getMaterial(h.db, s, id);
    expect(data!.material).toMatchObject({ grades: [5, 6], priceCents: 1990, subjectName: "Musik", provision: "leihe" });
    expect(data!.copies.map((c) => c.inventoryNumber)).toEqual([...numbers, ...more]);

    const c0 = data!.copies[0]!;
    await updateMaterialCopy(h.db, s, c0.id, { condition: "schlecht", conditionNote: "Einband lose", acquiredYear: "2026" });
    await fails(updateMaterialCopy(h.db, s, c0.id, { condition: "kaputt" }), /Zustand/);
    await withdrawMaterialCopy(h.db, s, c0.id, "verschlissen", TODAY);
    await fails(withdrawMaterialCopy(h.db, s, c0.id, "noch mal", TODAY), /schon ausgesondert/);
    await restoreMaterialCopy(h.db, s, c0.id);
    const [row] = await h.db.select().from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.id, c0.id));
    expect(row).toMatchObject({ condition: "schlecht", conditionNote: "Einband lose", withdrawnOn: null });

    // Umstellen auf „selbst kaufen“ nur ohne Exemplare im Bestand; löschen nur ohne Exemplare
    await fails(updateMaterial(h.db, s, id, { title: "Klangwelten 5/6", grades: [5, 6], provision: "kauf" }), /noch Exemplare/);
    await fails(deleteMaterial(h.db, s, id), /archivieren/);
    const listed = await listMaterials(h.db, s, { grade: 6, subjectId: "MU" });
    expect(listed.map((m) => m.title)).toEqual(["Klangwelten 5/6"]);
    expect(listed[0]).toMatchObject({ copies: 5, worn: 1 });
    expect((await listMaterials(h.db, s, { q: numbers[1] })).map((m) => m.id)).toEqual([id]);

    // Die Theke der Stufe 1 verbucht kein Schulbuch als Büchereiausleihe – BU-11: sie erkennt `L-` und verweist auf die Ausgabe
    await fails(scanAtDesk(h.db, s, numbers[1]!, LEA, TODAY), /ist ein Schulbuch.*Schulbuchausgabe/);

    const { id: tmp } = await createMaterial(h.db, s, { title: "Fehlerfassung", grades: [5], provision: "kauf" });
    await deleteMaterial(h.db, s, tmp);
    const acts = (await h.db.select({ action: auditLog.action }).from(auditLog)).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["buecherei.material.create", "buecherei.material.copy.withdraw", "buecherei.material.delete"]));
  });

  it("Bücherliste: Leihe und Kauf getrennt, Summe; Entwurf nur für die Pflege; archiviert fehlt", async () => {
    const s = await p(SABINE);
    const lea = await p(LEA);
    const five = await booklist(h.db, lea, 5);
    expect(five).toMatchObject({ grade: 5, published: true });
    expect(five!.text).toContain("Schutzumschlag");
    expect(five!.loan.map((i) => i.title)).toEqual(expect.arrayContaining(["Wortwerkstatt Deutsch 5", "Zahlenwege 5", "Schulatlas Lindenhof", "Klangwelten 5/6"]));
    expect(five!.buy.map((i) => i.title)).toEqual(["Zahlenwege 5 – Arbeitsheft"]);
    expect(five!.buyTotalCents).toBe(1095);
    // kein Personenbezug im Datenobjekt
    expect(Object.keys(five!).sort()).toEqual(["buy", "buyTotalCents", "grade", "gradeName", "loan", "published", "text"]);
    expect(Object.keys(five!.loan[0]!).sort()).toEqual(["author", "id", "isbn", "priceCents", "provision", "publisher", "subjectName", "title", "course"].sort());

    // Jahrgang 6 ist Entwurf: Schülerin und Eltern sehen ihn nicht, die Verwaltung schon
    expect(await booklist(h.db, lea, 6)).toBeNull();
    expect(await booklist(h.db, await p(MUTTER), 6)).toBeNull();
    expect((await booklist(h.db, s, 6))!.published).toBe(false);
    expect(await booklist(h.db, s, 99)).toBeNull();
    expect((await publishedGrades(h.db)).map((g) => g.level)).toEqual([5]);

    // freigeben mit Text; Text begrenzt
    await saveBooklist(h.db, s, 6, { text: "Bitte Umschläge.\r\nDanke", published: true });
    const six = await booklist(h.db, lea, 6);
    expect(six).toMatchObject({ published: true, text: "Bitte Umschläge.\nDanke" });
    await fails(saveBooklist(h.db, s, 6, { text: "x".repeat(2001), published: true }), /2000/);
    await fails(saveBooklist(h.db, s, 99, { text: "", published: true }), /Jahrgang/);
    const overview = await booklistOverview(h.db, s);
    expect(overview.find((g) => g.level === 6)).toMatchObject({ published: true, materials: expect.any(Number) });

    // archivieren nimmt das Lernmittel von der Liste
    const [atlas] = await h.db.select({ id: buechereiTeachingMaterials.id }).from(buechereiTeachingMaterials).where(eq(buechereiTeachingMaterials.title, "Schulatlas Lindenhof"));
    await setMaterialArchived(h.db, s, atlas!.id, true, TODAY);
    await fails(setMaterialArchived(h.db, s, atlas!.id, true, TODAY), /schon archiviert/);
    expect((await booklist(h.db, lea, 6))!.loan.map((i) => i.title)).not.toContain("Schulatlas Lindenhof");
    expect((await listMaterials(h.db, s, { q: "Schulatlas" })).length).toBe(0);
    expect((await listMaterials(h.db, s, { q: "Schulatlas", archived: true })).length).toBe(1);
    await setMaterialArchived(h.db, s, atlas!.id, false, TODAY);
  });

  it("Bücherliste lesen: alle mit Bücherei-Zugang und Eltern; Vorauswahl eigener Jahrgang bzw. der Kinder", async () => {
    for (const who of [JANA, AYLIN, MUTTER]) expect(await booklist(h.db, await p(who), 5)).not.toBeNull();
    expect(await ownGrades(h.db, await p(LEA))).toEqual([7]);
    expect(await ownGrades(h.db, await p(MUTTER))).toContain(7); // Lea; Geschwister in anderen Jahrgängen kommen dazu
    expect(await ownGrades(h.db, await p(JANA))).toEqual([]);
  });

  it("Etiketten-Baustein: Inventarnummern eines Lernmittels ohne ausgesonderte, ohne Warteschlange", async () => {
    const s = await p(SABINE);
    const [m] = await h.db.select({ id: buechereiTeachingMaterials.id }).from(buechereiTeachingMaterials).where(eq(buechereiTeachingMaterials.title, "Zahlenwege 5"));
    const labels = await materialLabels(h.db, s, { materialId: m!.id });
    expect(labels.length).toBe(6);
    expect(labels.every((l) => l.barcode.startsWith("L-") && l.printed && l.signature === "Lernmittel M" && l.title === "Zahlenwege 5")).toBe(true);
    const one = await materialLabels(h.db, s, { copyId: labels[0]!.copyId });
    expect(one.map((l) => l.barcode)).toEqual([labels[0]!.barcode]);
  });

  it("Löschregel Stufe 2 (Vorbereitung BU-11): Lernmittel, Exemplare und Bücherlisten tragen keinen Personenbezug", () => {
    for (const t of [buechereiTeachingMaterials, buechereiMaterialCopies, buechereiBooklists]) {
      const cfg = getTableConfig(t);
      expect(cfg.name in NO_PERSONAL_DATA).toBe(true);
      expect(cfg.columns.map((c) => c.name).filter((n) => /user|person|student|parent|name$/.test(n))).toEqual([]);
      expect(cfg.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name)).not.toContain("users");
    }
  });
});
