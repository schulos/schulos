import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { absenceReports, groupMembers, parentChild, parentLetterReceipts, parentLetters, surveys, timetableSubstitutions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadModuleStates, setModuleEnabled } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import { collectOpenItems, type OpenItem } from "@/core/open-items";
import { loadPermissions } from "@/core/permissions";
import { fromBerlinLocal } from "@/core/time";
import { MODULES } from "@/modules";
import { OPEN_ITEM_PROVIDERS } from "@/modules/open-items";
import { reportAbsence } from "@/modules/abwesenheiten/service";
import { remindLetter } from "@/modules/elternbriefe/service";
import elternbriefeManifest from "@/modules/elternbriefe/manifest";
import { createAbsence, needsOn } from "@/modules/stundenplan/abwesenheit";
import { SUBSTITUTION_RELEASE } from "@/modules/stundenplan/settings";
import { saveSubstitution } from "@/modules/stundenplan/vertretung";
import { setPrefWindow } from "@/modules/stundenplan/zeitwunsch-fenster";
import { createSurvey } from "@/modules/umfragen/service";
import { backupItem } from "@/modules/verwaltung/open";

// Mo 5.10.2026, 8 Uhr
const NOW = fromBerlinLocal("2026-10-05T08:00");
const TODAY = "2026-10-05";

describe("Offen für dich (Q5-07)", () => {
  let h: DbHandle;
  let mother: string;
  const items = async (userId: string): Promise<OpenItem[]> => {
    const perms = await loadPermissions(h.db, userId);
    return collectOpenItems(h.db, { perms } as CurrentUser, OPEN_ITEM_PROVIDERS, MODULES, await loadModuleStates(h.db), NOW);
  };
  const ids = (list: OpenItem[]) => list.map((i) => i.id.replace(/:[0-9a-f-]{36}$/, ""));

  beforeAll(async () => {
    h = await createSeededTestDb();
    // definierter Ausgangszustand: keine Demo-Briefe, -Meldungen, -Umfragen, -Vertretungen
    await h.db.delete(parentLetters);
    await h.db.delete(absenceReports);
    await h.db.delete(surveys);
    await h.db.delete(timetableSubstitutions);
    [{ mother }] = (await h.db.select({ mother: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ mother: string }];
  }, 60_000);
  afterAll(() => h.close());

  it("ohne offene Vorgänge: nichts (Demo: keine Backup-Ampel)", async () => {
    expect(await items(mother)).toEqual([]);
    expect(await items("u-lea.schaefer")).toEqual([]);
    expect(await items("u-jana.brandt")).toEqual([]);
  });

  it("Elternbrief: Eltern sehen „bestätigen“ je Kind, die Verfasserin den Rücklauf mit „Erinnern“ – andere Lehrkräfte nichts", async () => {
    const [letter] = await h.db
      .insert(parentLetters)
      .values({ title: "Wandertag", body: "…", authorId: "u-jana.brandt", responseType: "yesno", question: "Darf Ihr Kind mit?", dueDate: "2026-10-09" })
      .returning();
    const kids = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler")));
    await h.db.insert(parentLetterReceipts).values(kids.map((k) => ({ letterId: letter!.id, studentId: k.id })));
    await h.db
      .update(parentLetterReceipts)
      .set({ confirmedAt: new Date() })
      .where(and(eq(parentLetterReceipts.letterId, letter!.id), eq(parentLetterReceipts.studentId, kids.find((k) => k.id !== "u-lea.schaefer")!.id)));

    const mum = await items(mother);
    expect(mum).toEqual([expect.objectContaining({ id: "elternbriefe:bestaetigen", count: 1, detail: "für Lea", href: "/elternbriefe", tone: "warn" })]);

    const jana = (await items("u-jana.brandt")).find((i) => i.id.startsWith("elternbriefe:ruecklauf"))!;
    expect(jana).toMatchObject({ label: "Rücklauf „Wandertag“", count: kids.length - 1, detail: `1 von ${kids.length} bestätigt · bis 09.10.`, remindLetterId: letter!.id });
    // „Erinnern“ verschwindet für 12 Stunden
    await remindLetter(h.db, await loadPermissions(h.db, "u-jana.brandt"), letter!.id, NOW);
    expect((await items("u-jana.brandt")).find((i) => i.id.startsWith("elternbriefe:ruecklauf"))!.remindLetterId).toBeUndefined();
    // fremder Brief: Kollegin und Sekretariat (send_all) sehen keinen Rücklauf
    expect(ids(await items("u-tobias.kleine"))).not.toContain("elternbriefe:ruecklauf");
    expect(ids(await items("u-sabine.kowalski"))).not.toContain("elternbriefe:ruecklauf");
    // Schülerin: nie
    expect(await items("u-lea.schaefer")).toEqual([]);
  });

  it("Krankmeldung: Eltern „noch nicht entschieden“, Klassenleitung „entscheiden“ – eine Lehrkraft ohne Klasse nichts", async () => {
    await reportAbsence(h.db, await loadPermissions(h.db, mother), { studentId: "u-lea.schaefer", fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY);
    expect((await items(mother)).find((i) => i.id === "abwesenheiten:gemeldet")).toMatchObject({ count: 1, detail: "Lea", tone: "info" });
    expect((await items("u-jana.brandt")).find((i) => i.id === "abwesenheiten:entscheiden")).toMatchObject({ count: 1, detail: "Klasse 7b", tone: "warn" });
    expect(ids(await items("u-tobias.kleine"))).not.toContain("abwesenheiten:entscheiden");
  });

  it("Umfrage: an die Zielgruppe, bis sie beantwortet ist", async () => {
    await createSurvey(
      h.db,
      await loadPermissions(h.db, "u-jana.brandt"),
      {
        title: "Elternabend: Termin",
        description: "",
        anonymous: false,
        opensAt: new Date("2026-10-04T06:00:00Z"),
        closesAt: new Date("2026-10-12T20:00:00Z"),
        targets: { roles: [], groups: [{ groupId: "g-7b", parents: true }] },
        questions: [{ kind: "single", text: "Welcher Tag?", options: ["Di", "Do"], required: true }],
      },
      new Date("2026-10-04T08:00:00Z"),
    );
    expect((await items(mother)).find((i) => i.id === "umfragen:offen")).toMatchObject({ count: 1, detail: "Elternabend: Termin" });
    expect(ids(await items("u-lea.schaefer"))).not.toContain("umfragen:offen");
  });

  it("Planung: Vertretungsbedarf, Entwurf (Q5-11); Lehrkraft: Zeitwünsche (Q5-10); ohne Planungsrecht keine Planungszahlen", async () => {
    await createAbsence(h.db, "u-frank.schulte", { teacherId: "u-jana.brandt", groupId: null, startsOn: TODAY, endsOn: TODAY, fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    const plan = await items("u-frank.schulte");
    const need = plan.find((i) => i.id === "stundenplan:bedarf")!;
    expect(need.count).toBeGreaterThan(0);
    expect(need).toMatchObject({ tone: "danger", href: `/planung/vertretungen?datum=${TODAY}` });
    expect(need.detail).toMatch(/^Mo\., 5\.10\.: \d+/);
    // keine Planungszahlen für Lehrkräfte, Eltern
    expect(ids(await items("u-murat.yilmaz")).filter((i) => i.startsWith("stundenplan:"))).toEqual([]);
    // SP-02 (FEINSCHLIFF I-27): Schulleitung (Gruppe mit `stundenplan.substitute`) sieht den Vertretungsbedarf
    expect(ids(await items("u-tobias.kleine"))).toContain("stundenplan:bedarf");
    expect(ids(await items(mother)).filter((i) => i.startsWith("stundenplan:"))).toEqual([]);

    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
    const open = (await items("u-frank.schulte")).find((i) => i.id === "stundenplan:bedarf")!;
    // eine offene Stunde als Entfall eintragen → Tag wird Entwurf
    const first = (await needsOn(h.db, TODAY)).open.find((o) => o.status === "open")!;
    await saveSubstitution(h.db, "u-frank.schulte", { lessonId: first.lessonId, date: TODAY, kind: "cancel", substituteId: null, roomId: null, note: null });
    const after = await items("u-frank.schulte");
    expect(after.find((i) => i.id === "stundenplan:bedarf")?.count ?? 0).toBe(open.count! - 1);
    expect(after.find((i) => i.id === "stundenplan:entwurf")).toMatchObject({ count: 1, href: `/planung/vertretungen?datum=${TODAY}`, tone: "warn" });

    await setPrefWindow(h.db, "u-frank.schulte", { opensOn: TODAY, closesOn: "2026-10-16" }, TODAY);
    expect((await items("u-tobias.kleine")).find((i) => i.id === "stundenplan:zeitwuensche")).toMatchObject({ label: "Zeitwünsche abgeben bis 16.10.2026", href: "/stundenplan/zeitwuensche" });
    // die Erinnerung bekommen nur Lehrkräfte (auch die planende Lehrkraft), nicht das Sekretariat
    expect(ids(await items("u-frank.schulte"))).toContain("stundenplan:zeitwuensche");
    expect(ids(await items("u-sabine.kowalski"))).not.toContain("stundenplan:zeitwuensche");
  });

  it("Reihenfolge: dringend zuerst; ausgeschaltetes Modul liefert nichts", async () => {
    const plan = await items("u-frank.schulte");
    const order = { danger: 0, warn: 1, info: 2 } as const;
    expect(plan.map((i) => order[i.tone])).toEqual([...plan.map((i) => order[i.tone])].sort());
    await setModuleEnabled(h.db, elternbriefeManifest, false);
    expect(ids(await items(mother))).not.toContain("elternbriefe:bestaetigen");
    await setModuleEnabled(h.db, elternbriefeManifest, true);
  });

  it("Backup-Ampel: nur bei fehlender, fehlgeschlagener oder überfälliger Sicherung", () => {
    const base = { paired: true, health: "ok" as const, lastOkAt: NOW, lastRun: null, contactError: null, lastContactAt: null, runningSince: null, restoreRequest: null, lastRestore: null };
    expect(backupItem(base)).toBeNull();
    expect(backupItem({ ...base, paired: false })).toMatchObject({ label: "Keine Sicherung eingerichtet", tone: "danger", href: "/verwaltung/backup" });
    expect(backupItem({ ...base, health: "failed" })?.label).toBe("Sicherung fehlgeschlagen");
    expect(backupItem({ ...base, health: "overdue" })?.label).toBe("Sicherung überfällig");
  });
});

describe("Offen für dich: Rahmen", () => {
  it("ein kaputter Lieferant legt das Widget nicht lahm; leere Zähler fallen weg", async () => {
    const ok = { moduleId: "heute", collect: async () => [{ id: "a", moduleId: "heute", label: "A", count: 0, href: "/", tone: "info" as const }, { id: "b", moduleId: "heute", label: "B", href: "/", tone: "danger" as const }] };
    const broken = { moduleId: "heute", collect: async () => Promise.reject(new Error("kaputt")) };
    const manifests = MODULES.filter((m) => m.id === "heute");
    const out = await collectOpenItems({} as never, {} as CurrentUser, [broken, ok], manifests, new Map());
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });
});
