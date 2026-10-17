import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, taskGroups, tasks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadModuleStates, setModuleEnabled } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import messenger from "@/modules/messenger/manifest";
import { ValidationError } from "@/modules/verwaltung/users";
import { kurseSearch } from "./search";
import { courseHub, myCourses, parseConferenceLink, searchCourses, setConferenceLink, setCourseFeature } from "./service";
import { KONFERENZ_SETTING } from "./settings";

// Montag, 05.10.2026, 08:00 Uhr in Berlin
const NOW = new Date("2026-10-05T06:00:00Z");

describe("Kursraum", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const states = () => loadModuleStates(h.db);

  // Demo-Aufgaben aus dem Seed hängen am echten Datum – die Tests prüfen nur ihre eigenen („t-kurs-…“)
  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.insert(tasks).values([
      { id: "t-kurs-offen", title: "Gedicht interpretieren", authorId: "u-jana.brandt", startsAt: new Date("2026-10-01T06:00:00Z"), dueAt: new Date("2026-10-09T20:00:00Z") },
      { id: "t-kurs-spaeter", title: "Noch nicht gestartet", authorId: "u-jana.brandt", startsAt: new Date("2026-10-07T06:00:00Z"), dueAt: new Date("2026-10-12T20:00:00Z") },
      { id: "t-kurs-vorbei", title: "Schon vorbei", authorId: "u-jana.brandt", startsAt: new Date("2026-09-20T06:00:00Z"), dueAt: new Date("2026-10-02T20:00:00Z") },
    ]);
    await h.db.insert(taskGroups).values(["t-kurs-offen", "t-kurs-spaeter", "t-kurs-vorbei"].map((taskId) => ({ taskId, groupId: "g-7b" })));
  }, 60_000);
  afterAll(() => h.close());

  it("„Meine Gruppen“: nur eigene, Klassen zuerst, Leitung markiert", async () => {
    const lea = await myCourses(h.db, await p("u-lea.schaefer"));
    expect(lea[0]).toMatchObject({ id: "g-7b", kind: "klasse", kindLabel: "Klasse", leader: false });
    expect(lea.every((c) => c.members > 0)).toBe(true);
    const jana = await myCourses(h.db, await p("u-jana.brandt"));
    expect(jana.find((c) => c.id === "g-7b")?.leader).toBe(true);
    expect(jana.map((c) => c.id)).toContain("g-q1-e-gk1");
    expect(lea.map((c) => c.id)).not.toContain("g-q1-e-gk1");
  });

  it("Schülerin sieht ihren Kursraum mit Stunden, Aufgaben, Terminen, Ordner, Chat und Mitgliedern", async () => {
    const hub = (await courseHub(h.db, await p("u-lea.schaefer"), "g-7b", await states(), NOW))!;
    expect(hub.member).toBe(true);
    expect(hub.group.name).toBe("Klasse 7b");
    expect(hub.lessons?.items?.length).toBeGreaterThan(0);
    expect(hub.lessons!.items![0]!.date).toBe("2026-10-05");
    // nur gestartete, nicht abgelaufene Aufgaben – mit eigenem Stand
    expect(hub.tasks?.items?.filter((t) => t.id.startsWith("t-kurs-")).map((t) => [t.id, t.status])).toEqual([["t-kurs-offen", "offen"]]);
    expect(hub.events?.items).not.toBeNull();
    expect(hub.files?.items).not.toBeNull();
    expect(hub.chat?.roomId).toBe("room-g-7b");
    expect(hub.members[0]).toMatchObject({ id: "u-jana.brandt", leader: true });
    expect(hub.members.some((m) => m.id === "u-lea.schaefer")).toBe(true);
  });

  it("Leitung sieht auch geplante Aufgaben, mit Abgabezahl statt eigenem Stand", async () => {
    const hub = (await courseHub(h.db, await p("u-jana.brandt"), "g-7b", await states(), NOW))!;
    expect(hub.leader).toBe(true);
    expect(hub.tasks?.items?.filter((t) => t.id.startsWith("t-kurs-")).map((t) => [t.id, t.submitted])).toEqual([
      ["t-kurs-offen", 0],
      ["t-kurs-spaeter", 0],
    ]);
  });

  it("fremde Gruppe: kein Zugriff; Verwaltung öffnet sie, Ordner/Termine/Chat bleiben Mitgliedern vorbehalten", async () => {
    expect(await courseHub(h.db, await p("u-lea.schaefer"), "g-q1-e-gk1", await states(), NOW)).toBeNull();
    expect(await courseHub(h.db, await p("u-lea.schaefer"), "gibt-es-nicht", await states(), NOW)).toBeNull();
    const sabine = await p("u-sabine.kowalski");
    const hub = (await courseHub(h.db, sabine, "g-7b", await states(), NOW))!;
    expect(hub.member).toBe(false);
    expect(hub.files).toEqual({ items: null });
    expect(hub.events).toEqual({ items: null });
    expect(hub.chat).toEqual({ roomId: null, items: null });
    expect(hub.members.length).toBeGreaterThan(20);
    expect((await searchCourses(h.db, sabine, "7b")).map((g) => g.id)).toContain("g-7b");
    expect(await searchCourses(h.db, await p("u-lea.schaefer"), "7b")).toEqual([]);
  });

  it("Leitung schaltet Bereiche ihres Kurses; Mitglieder und fremde Lehrkräfte nicht (P3-02)", async () => {
    const jana = await p("u-jana.brandt");
    const before = (await courseHub(h.db, jana, "g-7b", await states(), NOW))!;
    expect(before.manage?.find((f) => f.id === "messenger.raum")?.enabled).toBe(true);
    expect((await courseHub(h.db, await p("u-lea.schaefer"), "g-7b", await states(), NOW))!.manage).toBeNull();

    await setCourseFeature(h.db, jana, "g-7b", "messenger.raum", false, await states());
    const off = (await courseHub(h.db, await p("u-lea.schaefer"), "g-7b", await states(), NOW))!;
    expect(off.chat).toBeNull();
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.group.feature")).orderBy(desc(auditLog.id)).limit(1);
    expect(log).toMatchObject({ actorId: "u-jana.brandt", target: "g-7b", meta: { feature: "messenger.raum", enabled: false } });

    await expect(setCourseFeature(h.db, await p("u-lea.schaefer"), "g-7b", "messenger.raum", true, await states())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCourseFeature(h.db, await p("u-daniel.okafor"), "g-7b", "messenger.raum", true, await states())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCourseFeature(h.db, jana, "g-7b", "gibt.es-nicht", true, await states())).rejects.toBeInstanceOf(ValidationError);
    // Sekretariat darf über die Gruppenverwaltung
    await setCourseFeature(h.db, await p("u-sabine.kowalski"), "g-7b", "messenger.raum", true, await states());
    expect((await courseHub(h.db, await p("u-lea.schaefer"), "g-7b", await states(), NOW))!.chat?.roomId).toBe("room-g-7b");
  });

  it("Suche findet eigene Kurse; Verwaltung auch fremde", async () => {
    const lea = { perms: await p("u-lea.schaefer") } as Parameters<typeof kurseSearch.search>[1];
    expect((await kurseSearch.search(h.db, lea, "7b")).map((r) => r.href)).toEqual(["/kurse/g-7b"]);
    expect(await kurseSearch.search(h.db, lea, "q1")).toEqual([]);
    const sabine = { perms: await p("u-sabine.kowalski") } as Parameters<typeof kurseSearch.search>[1];
    expect((await kurseSearch.search(h.db, sabine, "q1 e")).length).toBeGreaterThan(0);
  });

  it("Konferenzlink (V-01): nur mit Schalter, setzen nur Leitung/Lehrkräfte der Gruppe/Verwaltung, protokolliert ohne Adresse", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    // Vorgabe aus: kein Abschnitt, Setzen abgelehnt
    expect((await courseHub(h.db, jana, "g-7b", await states(), NOW))!.conference).toBeNull();
    await expect(setConferenceLink(h.db, jana, "g-7b", { url: "https://konferenz.example.org/raum-7b" })).rejects.toBeInstanceOf(ValidationError);

    await writeModuleSetting(h.db, KONFERENZ_SETTING, "an");
    try {
      expect((await courseHub(h.db, jana, "g-7b", await states(), NOW))!.conference).toEqual({ link: null, canEdit: true });
      expect((await courseHub(h.db, lea, "g-7b", await states(), NOW))!.conference).toEqual({ link: null, canEdit: false });

      await setConferenceLink(h.db, jana, "g-7b", { url: " https://konferenz.example.org/raum-7b?pw=geheim ", label: "" });
      const seen = (await courseHub(h.db, lea, "g-7b", await states(), NOW))!.conference;
      expect(seen?.link).toEqual({ url: "https://konferenz.example.org/raum-7b?pw=geheim", label: "Konferenzraum", host: "konferenz.example.org" });
      const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "kurse.konferenz.setzen")).orderBy(desc(auditLog.id)).limit(1);
      expect(log).toMatchObject({ actorId: "u-jana.brandt", target: "g-7b", meta: { host: "konferenz.example.org" } });
      expect(JSON.stringify(log!.meta)).not.toContain("geheim");

      await expect(setConferenceLink(h.db, lea, "g-7b", { url: "https://x.example.org" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setConferenceLink(h.db, await p("u-daniel.okafor"), "g-7b", { url: "https://x.example.org" })).rejects.toBeInstanceOf(ForbiddenError);
      // Sekretariat (Gruppenverwaltung) ändert, Leitung entfernt
      await setConferenceLink(h.db, await p("u-sabine.kowalski"), "g-7b", { url: "https://konferenz.example.org/neu", label: "Videoraum 7b" });
      expect((await courseHub(h.db, lea, "g-7b", await states(), NOW))!.conference?.link?.label).toBe("Videoraum 7b");
      await setConferenceLink(h.db, jana, "g-7b", { url: "" });
      expect((await courseHub(h.db, lea, "g-7b", await states(), NOW))!.conference?.link).toBeNull();
    } finally {
      await writeModuleSetting(h.db, KONFERENZ_SETTING, "aus");
    }
  });

  it("Konferenzlink: nur https, keine Zugangsdaten in der Adresse, Längen begrenzt", () => {
    expect(parseConferenceLink({ url: "https://raum.example.org/a b" }).url).toBe("https://raum.example.org/a%20b");
    for (const url of ["http://raum.example.org", "javascript:alert(1)", "raum.example.org", "https://nutzer:pw@raum.example.org", `https://raum.example.org/${"x".repeat(500)}`])
      expect(() => parseConferenceLink({ url }), url).toThrow(ValidationError);
    expect(() => parseConferenceLink({ url: "https://raum.example.org", label: "x".repeat(61) })).toThrow(ValidationError);
  });

  it("abgeschaltetes Modul → Abschnitt fehlt", async () => {
    await setModuleEnabled(h.db, messenger, false);
    try {
      const hub = (await courseHub(h.db, await p("u-lea.schaefer"), "g-7b", await states(), NOW))!;
      expect(hub.chat).toBeNull();
      expect(hub.files).not.toBeNull();
    } finally {
      await setModuleEnabled(h.db, messenger, true);
    }
  });
});
