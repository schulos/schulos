import { eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { appSettings, auditLog, grants, groupMembers, groups, users, type Role } from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { createSeededTestDb } from "@/core/db/testing";
import { loadModuleStates, setModuleEnabled } from "@/core/modules/registry";
import { readModuleSettings } from "@/core/modules/settings";
import { setSchoolLogo, readLogos } from "@/core/school/logo";
import { readSchoolSettings, readSecuritySettings } from "@/core/settings";
import { createUserWithPassword } from "@/core/auth/auth";
import { MODULES } from "@/modules";
import { buildSchulprofil, exportSchulprofil, importSchulprofil, parseSchulprofil, profileKeys, schulprofilSchema, type Schulprofil } from "./schulprofil";
import { ValidationError } from "./users";

// P4-77: Schulprofil – Export/Import ohne Personendaten. Das Schema lässt strukturell nichts anderes zu (Test „kann nicht“),
// der Export aus der Demo-Schule enthält keine Namen/Adressen/Benutzernamen (Test „enthält nicht“).

function memStorage(): FileStorage {
  const files = new Map<string, Uint8Array>();
  return {
    put: async (k, d) => void files.set(k, d),
    get: async (k) => {
      const d = files.get(k);
      return d ? new Response(d as unknown as BodyInit).body : null;
    },
    delete: async (k) => void files.delete(k),
    list: async () => [...files.keys()].map((key) => ({ key, modifiedAt: new Date() })),
  };
}

// kleinstes gültiges PNG (1×1)
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

describe("P4-77: Schulprofil", () => {
  let src: DbHandle;
  let dst: DbHandle;
  const storage = memStorage();
  let profile: Schulprofil;

  beforeAll(async () => {
    [src, dst] = await Promise.all([createSeededTestDb(), createSeededTestDb()]);
    // „echte“ Schule: eigener Name, Symbol, Modul aus, Einstellung, Recht, Inaktivitätsablauf
    await src.db.update(appSettings).set({ value: "Realschule am Teich" }).where(eq(appSettings.key, "school.name"));
    await src.db
      .insert(appSettings)
      .values({ key: "school.color", value: "#7A1F5C" })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: "#7A1F5C" } });
    await setSchoolLogo(src.db, storage, null, "symbol", PNG);
    await src.db
      .insert(appSettings)
      .values({ key: "sicherheit.inaktiv_minuten", value: 60 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 60 } });
  }, 60_000);
  afterAll(async () => {
    await src.close();
    await dst.close();
  });

  it("Export: Schuldaten, Logo, Module, Einstellungen, Rollenrechte – und keinerlei Personendaten", async () => {
    profile = await exportSchulprofil(src.db, storage, MODULES, "u-admin", new Date("2026-10-14T10:00:00Z"));
    expect(profile.school.name).toBe("Realschule am Teich");
    expect(profile.school.color).toBe("#7A1F5C");
    expect(profile.logos.symbol?.mime).toBe("image/png");
    expect(Object.keys(profile.modules).length).toBeGreaterThan(10);
    expect(profile.roleGrants.lehrkraft.length).toBeGreaterThan(0);
    expect(profile.security.idleMinutes).toBe(60);

    // keine Personendaten: kein Benutzername, kein Name, keine E-Mail-Adresse und keine Gruppe (Klassen enthalten Personenbezug
    // über ihre Mitglieder) taucht irgendwo im Export auf
    const text = JSON.stringify({ ...profile, logos: {} });
    const people = await src.db.select({ username: users.username, name: users.name, email: users.email }).from(users);
    expect(people.length).toBeGreaterThan(100);
    for (const u of people) {
      for (const v of [u.username, u.name, u.email]) if (v && v.length > 3) expect(text, v).not.toContain(v);
    }
    const groupNames = (await src.db.select({ slug: groups.slug }).from(groups)).map((g) => g.slug).filter((s) => s.length > 3);
    for (const g of groupNames) expect(text).not.toContain(`"${g}"`);
    // keine Felder außer den erlaubten
    const allowed =
      /^(format|version|exportedAt|schulosVersion|school(\.(name|number|color|state|form|oberstufe|abitur))?|logos(\.(logo|dark|symbol)(\.(mime|data))?)?|modules(\.[a-z]+)?|moduleSettings(\.[a-z0-9_.]+)?|roleGrants(\.[a-z]+)?|security(\.idleMinutes)?)$/;
    expect(profileKeys(profile).filter((k) => !allowed.test(k))).toEqual([]);
    const log = await src.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schulprofil.export"));
    expect(log).toHaveLength(1);
  });

  it("Schema: Personen-, Noten- oder Freitextfelder können gar nicht enthalten sein", () => {
    const ok = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
    expect(() => parseSchulprofil(JSON.stringify(ok))).not.toThrow();
    // bewusst lose: der Test baut absichtlich ungültige Profile
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reject = (mutate: (p: Record<string, any>) => void, re: RegExp) => {
      const p = JSON.parse(JSON.stringify(ok));
      mutate(p);
      const err = (() => {
        try {
          parseSchulprofil(JSON.stringify(p));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ValidationError);
      expect(Object.values((err as ValidationError).fieldErrors)[0]).toMatch(re);
    };
    // zusätzliche Bereiche auf jeder Ebene
    reject((p) => (p.users = [{ name: "Lea Schäfer", email: "lea@example.org" }]), /nicht erlaubte Angabe\(n\): users/);
    reject((p) => (p.grades = [{ student: "Lea", grade: "2+" }]), /grades/);
    reject((p) => (p.school.headteacher = "Petra Lindner"), /school.*headteacher/);
    reject((p) => (p.logos.symbol.owner = "Petra Lindner"), /owner/);
    reject((p) => (p.security.schoolNets = "10.0.0.0/8"), /schoolNets/);
    reject((p) => (p.groupGrants = { "7b": ["news.post"] }), /groupGrants/);
    // Freitext in Bezeichner-Feldern
    reject((p) => (p.moduleSettings["messenger.student_direct"] = "Lea Schäfer, 7b"), /moduleSettings/);
    reject((p) => (p.modules["Lea Schäfer"] = true), /modules/);
    reject((p) => p.roleGrants.lehrkraft.push("Note 2 für Lea"), /roleGrants/);
    reject((p) => (p.roleGrants.admin = ["*"]), /admin/);
    reject((p) => (p.school.number = "Schule von Herrn Meier"), /school.number/);
    reject((p) => (p.security.idleMinutes = 7), /security.idleMinutes/);
    reject((p) => (p.logos.symbol.data = "kein base64!"), /logos.symbol.data/);
    reject((p) => (p.format = "etwas-anderes"), /format/);
    expect(() => parseSchulprofil("{ kaputt")).toThrow(expect.objectContaining({ fieldErrors: { file: expect.stringMatching(/kein gültiges JSON/) } }));
  });

  it("alle Optionswerte und Schlüssel der Moduleinstellungen und alle Rechte passen ins Schema", () => {
    const decls = MODULES.flatMap((m) => m.settings ?? []);
    const p = JSON.parse(JSON.stringify(profile));
    for (const d of decls) for (const o of d.options) p.moduleSettings[d.key] = o.value;
    p.roleGrants.verwaltung = MODULES.flatMap((m) => Object.keys(m.permissions ?? {}));
    expect(schulprofilSchema.safeParse(p).success).toBe(true);
  });

  it("Import in eine Demo-Instanz: übernimmt Zuschnitt, Personen bleiben unberührt; unbekanntes wird gemeldet", async () => {
    const before = await dst.db.select({ id: users.id, name: users.name }).from(users);
    const p = JSON.parse(JSON.stringify(profile)) as Schulprofil;
    p.modules.gibtsnicht = true;
    p.moduleSettings["gibts.nicht"] = "an";
    p.roleGrants.schueler = [...p.roleGrants.schueler, "notenbuch.use", "gibts.nicht"];
    const dstStorage = memStorage();
    const report = await importSchulprofil(dst.db, dstStorage, MODULES, "u-admin", p);
    expect(report.logos).toBe(1);
    expect(report.grants).toBeGreaterThan(0);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Modul „gibtsnicht“/),
        expect.stringMatching(/Einstellung „gibts.nicht“/),
        expect.stringMatching(/notenbuch.use.*schueler/),
        expect.stringMatching(/gibts.nicht.*unbekannt/),
      ]),
    );
    const school = await readSchoolSettings(dst.db);
    expect(school.name).toBe("Realschule am Teich");
    expect(school.color).toBe("#7A1F5C");
    expect((await readLogos(dst.db)).symbol?.mime).toBe("image/png");
    expect((await readSecuritySettings(dst.db)).idleMinutes).toBe(60);
    // Rollenrechte entsprechen dem Export (ohne die abgelehnten)
    const rows = await dst.db.select({ role: grants.role, permission: grants.permission }).from(grants).where(isNotNull(grants.role));
    expect(
      rows
        .filter((r) => r.role === "lehrkraft")
        .map((r) => r.permission)
        .sort(),
    ).toEqual([...profile.roleGrants.lehrkraft].sort());
    expect(rows.some((r) => r.role === "schueler" && r.permission === "notenbuch.use")).toBe(false);
    // Module und Einstellungen wie in der Quelle
    const states = await loadModuleStates(dst.db);
    for (const [id, on] of Object.entries(profile.modules)) expect(states.get(id) ?? on, id).toBe(on);
    const settings = await readModuleSettings(
      dst.db,
      MODULES.flatMap((m) => m.settings ?? []),
    );
    for (const [k, v] of Object.entries(profile.moduleSettings)) expect(settings.get(k), k).toBe(v);
    // Personen unverändert (Demo-Personen bleiben)
    expect(await dst.db.select({ id: users.id, name: users.name }).from(users)).toEqual(before);
    expect((await dst.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schulprofil.import"))).length).toBe(1);
    // ein zweiter Export aus der Vorschau ergibt denselben Zuschnitt
    const again = await buildSchulprofil(dst.db, dstStorage, MODULES);
    expect({ ...again, exportedAt: "", logos: {} }).toEqual({ ...profile, exportedAt: "", logos: {} });
  }, 60_000);

  it("G4E-C03: scheitert ein Schritt mitten in den Rechten, bleibt der alte Zuschnitt vollständig (eine Transaktion)", async () => {
    const roleRows = () => dst.db.select({ role: grants.role, permission: grants.permission }).from(grants).where(isNotNull(grants.role));
    const grantsBefore = await roleRows();
    const nameBefore = (await readSchoolSettings(dst.db)).name;
    const p = JSON.parse(JSON.stringify(profile)) as Schulprofil;
    p.school.name = "Halb eingespielte Schule";
    p.roleGrants.lehrkraft = [...p.roleGrants.lehrkraft, "news.manage"];
    // eingeschobener Fehler beim Anlegen eines Rechts der Lehrkräfte (nach dem Löschen aller Rollenrechte)
    await dst.db.execute(sql.raw(`create function g4e_c03() returns trigger language plpgsql as $$ begin raise exception 'Testfehler'; end $$`));
    await dst.db.execute(sql.raw(`create trigger g4e_c03 before insert on grants for each row when (new.role = 'lehrkraft') execute function g4e_c03()`));
    try {
      await expect(importSchulprofil(dst.db, null, MODULES, "u-admin", p)).rejects.toThrow();
    } finally {
      await dst.db.execute(sql.raw("drop trigger g4e_c03 on grants"));
      await dst.db.execute(sql.raw("drop function g4e_c03()"));
    }
    expect(await roleRows()).toEqual(grantsBefore);
    expect((await readSchoolSettings(dst.db)).name).toBe(nameBefore);
  }, 60_000);

  it("G4E-C11/S04: wie in der Oberfläche – Einstellungen mit eigenem Recht, Module mit Mailversand, eigene Rolle bleibt", async () => {
    // Person mit Schul- und Rechteverwaltung, aber ohne Datenschutz-Recht (Rolle Lehrkraft, Rechte über ein Gremium)
    await createUserWithPassword(dst.db, { id: "u-imp", name: "Import Test", username: "import.test", role: "lehrkraft" }, { plain: "irgendwas-langes-1" });
    await dst.db.insert(groups).values({ id: "g-imp", name: "Import-Team", slug: "import-team", kind: "gremium" });
    await dst.db.insert(groupMembers).values({ groupId: "g-imp", userId: "u-imp" });
    for (const permission of ["verwaltung.school", "verwaltung.rights", "news.write"]) await dst.db.insert(grants).values({ permission, groupId: "g-imp" });
    const roleOf = async (role: Role) =>
      (await dst.db.select({ permission: grants.permission }).from(grants).where(eq(grants.role, role))).map((r) => r.permission).sort();
    await dst.db.insert(grants).values({ permission: "kalender.school", role: "eltern" }).onConflictDoNothing();
    await setModuleEnabled(dst.db, MODULES.find((m) => m.id === "anmeldung")!, false);
    const lehrkraftBefore = await roleOf("lehrkraft");
    const elternBefore = await roleOf("eltern");
    expect(elternBefore.length).toBeGreaterThan(0);
    const grace = MODULES.flatMap((m) => m.settings ?? []).find((d) => d.key === "verwaltung.account_grace")!;
    const graceBefore = (await readModuleSettings(dst.db, [grace])).get(grace.key);
    const p = JSON.parse(JSON.stringify(profile)) as Schulprofil;
    p.moduleSettings["verwaltung.account_grace"] = graceBefore === "30" ? "365" : "30";
    p.modules.anmeldung = true;
    p.roleGrants.lehrkraft = [];
    p.roleGrants.eltern = [];
    p.roleGrants.personal = ["news.write"];
    const report = await importSchulprofil(dst.db, null, MODULES, "u-imp", p, { mail: false });
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Einstellung „verwaltung.account_grace“: darfst du selbst nicht ändern/),
        expect.stringMatching(/Modul „anmeldung“: braucht den E-Mail-Versand/),
      ]),
    );
    // Löschfrist unverändert, Schulanmeldung bleibt aus
    expect((await readModuleSettings(dst.db, [grace])).get(grace.key)).toBe(graceBefore);
    expect((await loadModuleStates(dst.db)).get("anmeldung") ?? false).toBe(false);
    // eigene Rolle (lehrkraft) unverändert; Rechte, die die Person nicht vergeben darf, bleiben bei den Eltern stehen
    expect(await roleOf("lehrkraft")).toEqual(lehrkraftBefore);
    expect(await roleOf("eltern")).toEqual(elternBefore);
    // was sie vergeben darf, wird ersetzt
    expect(await roleOf("personal")).toContain("news.write");
  }, 60_000);

  it("nie in eine echte Schule (Produktiv-Instanz)", async () => {
    const prod = await createSeededTestDb();
    try {
      await prod.db
        .insert(appSettings)
        .values({ key: "instance.type", value: "production" })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: "production" } });
      await expect(importSchulprofil(prod.db, null, MODULES, "u-admin", profile)).rejects.toMatchObject({ fieldErrors: { file: /nur in eine Demo/ } });
      expect((await readSchoolSettings(prod.db)).name).not.toBe("Realschule am Teich");
    } finally {
      await prod.close();
    }
  }, 60_000);
});
