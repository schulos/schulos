// SP2-10: Drucke und CSV-Exporte – Rechte-Matrix, Tabelleninhalt, CSV-Entschärfung.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { toCsv } from "@/core/csv";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { buildExport, canExport, EXPORT_ARTS, gridHead, gridRows, isExportArt, mergeByCoupling, type ExportArt } from "./exporte";
import type { LessonSlot } from "./service";

const TODAY = "2026-10-05";

function slot(p: Partial<LessonSlot>): LessonSlot {
  return {
    lessonId: "l",
    date: TODAY,
    weekday: 0,
    periodNr: 1,
    startsAt: "08:00",
    endsAt: "08:45",
    subjectId: "M",
    subjectName: "Mathe",
    color: "#000",
    groupId: "g1",
    groupName: "7a",
    teacherId: "t1",
    teacherName: "Tom",
    teacherCode: "TOM",
    roomId: null,
    week: "all",
    couplingId: null,
    ...p,
  };
}

describe("Raster (rein)", () => {
  it("Kopf und Zellen: Wochentag × Stunde, A-/B-Woche und Kurse in einer Zelle, Doppelte einmal", () => {
    expect(gridHead(2)).toEqual(["Mo 1", "Mo 2", "Di 1", "Di 2", "Mi 1", "Mi 2", "Do 1", "Do 2", "Fr 1", "Fr 2"]);
    const rows = gridRows(
      [
        {
          key: "a",
          label: "7a",
          slots: [slot({ week: "A" }), slot({ week: "B", subjectName: "Physik" }), slot({ weekday: 1, periodNr: 2 }), slot({ weekday: 1, periodNr: 2 }), slot({ weekday: 7 })],
        },
      ],
      2,
      (s) => s.subjectName,
    );
    expect(rows[0]![0]).toBe("7a");
    expect(rows[0]![1]).toBe("Mathe (A) / Physik (B)");
    expect(rows[0]![4]).toBe("Mathe"); // Di 2
    expect(rows[0]!.filter(Boolean)).toHaveLength(3); // Name + zwei Zellen
  });

  it("gekoppelte Stunden einer Lehrkraft werden zu einer mit allen Klassen", () => {
    const merged = mergeByCoupling([slot({ couplingId: "c", groupName: "7a" }), slot({ couplingId: "c", groupName: "7b" }), slot({ couplingId: null, periodNr: 2 })]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.groupName).toBe("7a, 7b");
  });
});

describe("Rechte je Export", () => {
  let h: DbHandle;
  const perms: Record<string, PermissionSet> = {};
  beforeAll(async () => {
    h = await createSeededTestDb();
    for (const [k, id] of Object.entries({
      admin: "u-admin",
      planung: "u-frank.schulte",
      lehrkraft: "u-jana.brandt",
      schueler: "u-lea.schaefer",
      sekretariat: "u-sabine.kowalski",
    })) {
      perms[k] = await loadPermissions(h.db, id);
    }
  });
  afterAll(() => h.close());

  const allowed = (p: string) => EXPORT_ARTS.filter((a) => canExport(a, perms[p]!));

  it("Planung (manage + substitute) darf alles", () => {
    expect(allowed("planung")).toEqual([...EXPORT_ARTS]);
  });

  it("Lehrkraft ohne Planungsrecht: nur Gesamtübersichten", () => {
    expect(allowed("lehrkraft")).toEqual(["gesamt-klassen", "gesamt-lehrkraefte"]);
  });

  it("Schüler:innen bekommen nichts", () => {
    expect(allowed("schueler")).toEqual([]);
  });

  it("Verteilung, Deputate und Aufsichtsplan sind personenbezogen: Sekretariat ohne `manage` ausgeschlossen", () => {
    for (const a of ["verteilung", "deputate", "aufsichten"] as ExportArt[]) {
      expect(canExport(a, perms.sekretariat!)).toBe(false);
    }
  });

  it("unbekannte Art wird abgelehnt", () => {
    expect(isExportArt("gesamt-klassen")).toBe(true);
    expect(isExportArt("alles")).toBe(false);
  });
});

describe("Inhalt (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Gesamtübersicht Klassen: eine Zeile je Klasse mit Stunden, Kopf passt zur Zeilenbreite", async () => {
    const t = await buildExport(h.db, "gesamt-klassen", { today: TODAY });
    expect(t.rows.length).toBeGreaterThan(3);
    expect(t.head[0]).toBe("Klasse");
    expect(t.head[1]).toBe("Mo 1");
    for (const r of t.rows) expect(r).toHaveLength(t.head.length);
    const sevenB = t.rows.find((r) => r[0] === "Klasse 7b");
    expect(sevenB).toBeDefined();
    expect(sevenB!.slice(1).filter(Boolean).length).toBeGreaterThan(10);
  });

  it("Gesamtübersicht Lehrkräfte: eine Zeile je Lehrkraft mit Kürzel, Klassen in den Zellen", async () => {
    const t = await buildExport(h.db, "gesamt-lehrkraefte", { today: TODAY });
    expect(t.rows.length).toBeGreaterThan(3);
    for (const r of t.rows) {
      expect(r).toHaveLength(t.head.length);
      expect(r[0]).toMatch(/\S/);
    }
    expect(t.rows.flat().some((c) => /7b/.test(c))).toBe(true);
  });

  it("Unterrichtsverteilung: Spalten wie der CSV-Import, Stunden pro Auftrag", async () => {
    const t = await buildExport(h.db, "verteilung", { today: TODAY });
    expect(t.head).toEqual(["Klasse/Kurs", "Fach", "Stunden", "Lehrkraft", "Doppelstunden", "Raumwunsch", "Band", "gültig ab", "gültig bis"]);
    expect(t.rows.length).toBeGreaterThan(5);
    expect(t.rows.every((r) => r.length === 9 && /^\d+(,\d)?$/.test(r[2]!))).toBe(true);
  });

  it("Deputate: Pflichtstunden, Soll und Saldo je Lehrkraft", async () => {
    const t = await buildExport(h.db, "deputate", { today: TODAY });
    expect(t.head).toContain("Saldo");
    expect(t.rows.length).toBeGreaterThan(3);
    expect(t.rows.every((r) => r.length === t.head.length && r[2] !== "")).toBe(true);
  });

  it("Aufsichtsplan: je Bereich und Pause eine Zeile, Kürzel je Wochentag", async () => {
    const t = await buildExport(h.db, "aufsichten", { today: TODAY });
    expect(t.head).toEqual(["Bereich", "Pause", "Mo", "Di", "Mi", "Do", "Fr"]);
    expect(t.rows.length).toBeGreaterThanOrEqual(3);
    expect(t.rows.map((r) => r[0])).toContain("Schulhof");
    expect(t.rows.every((r) => r.slice(2).every((c) => c !== ""))).toBe(true);
  });

  it("Vertretungsstatistik: Köpfe und leere Tabelle ohne Vertretungen im Monat", async () => {
    const l = await buildExport(h.db, "statistik-lehrkraefte", { today: TODAY, monat: true });
    const k = await buildExport(h.db, "statistik-klassen", { today: TODAY, monat: true });
    expect(l.head).toEqual(["Kürzel", "Name", "vertreten", "davon mit eigenem Fach", "abgegeben", "Entfall"]);
    expect(k.head).toEqual(["Klasse/Kurs", "vertreten", "davon mit anderem Fach", "Entfall"]);
    expect(l.subtitle).toContain("Dieser Monat");
    expect(l.rows).toEqual([]);
  });

  it("CSV: Semikolon, BOM, Umlaute und Formeln entschärft", async () => {
    const t = await buildExport(h.db, "verteilung", { today: TODAY });
    const csv = toCsv([t.head, ...t.rows, ["=1+1", "@x", "-3", "", "", "", "", "", ""]]);
    expect(csv.startsWith("﻿Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch;Band;gültig ab;gültig bis\r\n")).toBe(true);
    expect(csv).toContain("'=1+1;'@x;'-3;");
    expect(csv.split("\r\n").length).toBe(t.rows.length + 3);
  });
});
