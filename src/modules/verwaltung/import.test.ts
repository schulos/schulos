import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "@/core/auth/auth";
import type { DbHandle } from "@/core/db/client";
import { groupMembers } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { credentialsCsv, executeImport, parseStudentCsv, planImport } from "./import";

describe("parseStudentCsv", () => {
  it("liest mit Kopfzeile, BOM, Semikolon und Anführungszeichen", () => {
    const { rows, errors } = parseStudentCsv('﻿Vorname;Nachname;Klasse\nMia;"Müller; geb. Graf";5a\r\nNoah;Becker;5B\n\n');
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, firstName: "Mia", lastName: "Müller; geb. Graf", klasse: "5a", username: undefined },
      { line: 3, firstName: "Noah", lastName: "Becker", klasse: "5B", username: undefined },
    ]);
  });
  it("erkennt Komma-Trenner und vertauschte Spalten per Kopfzeile", () => {
    const { rows } = parseStudentCsv("Klasse,Nachname,Vorname,Benutzername\n6a,Kaya,Elif,elif.k");
    expect(rows[0]).toMatchObject({ firstName: "Elif", lastName: "Kaya", klasse: "6a", username: "elif.k" });
  });
  it("geht ohne Kopfzeile von Vorname;Nachname;Klasse aus", () => {
    expect(parseStudentCsv("Ida;Wolf;7a").rows[0]).toMatchObject({ firstName: "Ida", lastName: "Wolf", klasse: "7a" });
  });
  it("meldet unvollständige Zeilen mit Zeilennummer", () => {
    const { rows, errors } = parseStudentCsv("Vorname;Nachname;Klasse\nIda;;7a\nOle;Busch;7a");
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ line: 2, message: "Vorname, Nachname und Klasse sind Pflicht" }]);
  });
});

describe("Import (DB)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("plant: Klassen auflösen, Namen eindeutig in DB und Datei, Fehler markieren", async () => {
    const { rows } = parseStudentCsv("Lea;Schäfer;5a\nTom;Neu;5a\nTom;Neu;5b\nAna;X;12z\nJo;Y;Klasse 6b;jana.brandt");
    const plan = await planImport(h.db, rows);
    expect(plan[0]?.username).toBe("lea.schaefer2"); // lea.schaefer gibt es schon
    expect(plan[1]?.username).toBe("tom.neu");
    expect(plan[2]?.username).toBe("tom.neu2"); // doppelt in der Datei
    expect(plan[3]?.error).toMatch(/Klasse „12z“/);
    expect(plan[4]?.groupName).toBe("Klasse 6b");
    expect(plan[4]?.error).toMatch(/vergeben/);
  });

  it("führt aus: legt nur fehlerfreie Zeilen an, mit Klasse und funktionierendem Passwort", async () => {
    const plan = await planImport(h.db, parseStudentCsv("Vorname;Nachname;Klasse\nFinn;Importiert;5a\nKai;Fehler;99x").rows);
    const res = await executeImport(h.db, "u-admin", plan);
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toBe(1);
    const created = res.created[0]!;
    const m = await h.db.select().from(groupMembers).where(eq(groupMembers.userId, `u-${created.username}`));
    expect(m[0]?.groupId).toBe("g-5a");
    const login = await createAuth(h.db).api.signInUsername({ body: { username: created.username, password: created.password } });
    expect(login?.token).toBeTruthy();
  });

  it("bricht ab, wenn ein Name zwischen Vorschau und Import vergeben wurde", async () => {
    const plan = await planImport(h.db, parseStudentCsv("Pia;Doppelt;5a").rows);
    await executeImport(h.db, "u-admin", plan);
    await expect(executeImport(h.db, "u-admin", plan)).rejects.toThrow(/inzwischen vergeben/);
  });

  it("Zugangsdaten-CSV mit BOM und Escaping", () => {
    const csv = credentialsCsv([{ name: 'A "B"', klasse: "Klasse 5a", username: "a.b", password: "xyz" }]);
    expect(csv.startsWith("﻿Name;Klasse;Benutzername;Startpasswort\r\n")).toBe(true);
    expect(csv).toContain('"A ""B""";Klasse 5a;a.b;xyz');
  });
});
