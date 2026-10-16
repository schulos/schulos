// GATE-5a (Schülerzugriff): Schüler:innen und Eltern haben **keinen** Zugriff auf Notenbücher. Einzige Ausnahme ist die
// Schüler-/Elternsicht P5-14 (Moduleinstellung, Vorgabe aus): nur die eigenen Noten bzw. die der eigenen Kinder, lesend, ohne
// Kommentare, Vorschläge, Mitschüler:innen, Bücher, Übergabeliste und Export.
//
// Jeder Zugangsweg wird mit dem Schülerkonto lea.schaefer und ihrem Elternkonto der Demo geprüft – mit Sicht aus UND an. Dazu
// der schlimmste Fall einer Fehlkonfiguration: `notenbuch.*` an die Rollen schueler/eltern und an die Klassengruppe (direkt in
// die Datenbank, an der Rechteverwaltung vorbei), Datenschutzhinweis bestätigt und eine gültige Sitzung mit zweitem Faktor.
// Auch dann darf nichts durchgehen – die Sperre sitzt in `hasNotenbuchRight` (rollen.ts), Navigation, Actions und Export prüfen
// zusätzlich selbst. docs/SICHERHEIT.md „Schüler:innen und Eltern – kein Zugriff auf Notenbücher“ verweist hierher.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import type { Db, DbHandle } from "@/core/db/client";

const state = vi.hoisted(() => ({ db: null as unknown as Db, userId: "" }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("@/core/db/client", async (orig) => ({
  ...(await orig<typeof import("@/core/db/client")>()),
  getDb: async () => state.db,
}));
vi.mock("@/core/auth/auth", () => ({
  getAuth: async () => ({
    api: {
      getSession: async () =>
        state.userId
          ? { session: { id: `s-${state.userId}` }, user: { id: state.userId } }
          : null,
      signOut: async () => undefined,
    },
  }),
}));
vi.mock("@/core/auth/session", async (orig) => {
  const { loadPermissions: load } = await import("@/core/permissions");
  const current = async () => {
    const perms = await load(state.db, state.userId);
    return {
      user: {
        id: state.userId,
        name: "",
        firstName: "",
        lastName: "",
        shortCode: null,
        role: perms.role,
        username: "",
      },
      perms,
    };
  };
  return {
    ...(await orig<typeof import("@/core/auth/session")>()),
    getCurrentUser: current,
    requireUser: current,
    apiUser: async () => ({
      userId: state.userId,
      perms: await load(state.db, state.userId),
    }),
  };
});

import {
  grants,
  groupMembers,
  notenbuchBooks,
  notenbuchBookTeachers,
  notenbuchColumns,
  notenbuchEntries,
  notenbuchNoticeAcks,
  notenbuchTermGrades,
  parentChild,
  sessions,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { buildNav, loadModuleStates } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import {
  ForbiddenError,
  loadPermissions,
  type PermissionSet,
} from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { planOwnExport } from "@/core/privacy/eigenexport";
import { widgetsFor } from "@/core/widgets";
import { MODULES } from "@/modules";
import { addGroupGrant, setRoleGrant } from "@/modules/verwaltung/rights";
import { ValidationError } from "@/modules/verwaltung/users";
import NotenbuchLayout from "@/app/(shell)/notenbuch/layout";
import NotenbuchPage from "@/app/(shell)/notenbuch/page";
import NotenbuchBookPage from "@/app/(shell)/notenbuch/[id]/page";
import HandoverPage from "@/app/(shell)/notenbuch/klasse/[id]/page";
import { FamilyGrades } from "@/app/(shell)/notenbuch/noten";
import { POST as exportPost } from "@/app/api/notenbuch/export/route";
import * as actions from "./actions";
import { notenbuchAuskunft } from "./auskunft";
import { familyGrades, gradeOwners } from "./einsicht";
import { acknowledgeNotice, NOTICE_VERSION } from "./hinweis";
import { canOwnBooks, ownBookLinks } from "./links";
import notenbuch from "./manifest";
import { activateOfflineDevice, offlineShare, syncOfflineOps } from "./offline";
import { isFamilyRole } from "./rollen";
import { notenbuchSearch } from "./search";
import {
  addColumn,
  addColumnFromExam,
  adoptSuggestions,
  bookOptions,
  booksForTransfer,
  createBook,
  deleteColumn,
  examOptions,
  exportTermCsv,
  getBook,
  handoverClasses,
  hasNotenbuchRight,
  lockBook,
  lockedBooks,
  moveColumn,
  myBooks,
  NOTENBUCH_RIGHTS,
  notenbuchAccess,
  ownBook,
  setEntry,
  setFinalGrade,
  setWeights,
  termOverview,
  transferBook,
  transferTargets,
  unlockBook,
  updateColumn,
} from "./service";
import { notenbuchSessions } from "./schema";
import { PARENTS_VIEW, STUDENT_VIEW } from "./settings";
import { notenbuchWidgets } from "./widgets";

const LEA = "u-lea.schaefer"; // Schülerin der 7b
const JANA = "u-jana.brandt"; // führt das Buch
const MURAT = "u-murat.yilmaz";
const PETRA = "u-petra.lindner"; // Schulleitung, `notenbuch.auskunft` über die Gruppe
const ADMIN = "u-admin";
const YEAR = "sj-2026-27";
const TODAY = "2026-10-07";
const NOW = new Date("2026-10-07T10:00:00Z");
const DEVICE = "0f0e0d0c-0b0a-4908-8706-050403020100";
/** Was Schüler:innen und Eltern nie sehen dürfen: Kommentar, Note und Name einer Mitschülerin, Vorschlag */
const FOREIGN = /geheimer Kommentar|fremde Note|"computed"|"comment"|Vorschlag/;

describe("GATE-5a: Schüler:innen und Eltern – kein Zugriff auf Notenbücher", () => {
  let h: DbHandle;
  let parent = "";
  let other = ""; // Mitschülerin der 7b
  let otherName = "";
  let book = "";
  let column = "";
  const p = (id: string) => loadPermissions(h.db, id);
  const family = () => [
    { who: "Schülerin", id: LEA },
    { who: "Elternteil", id: parent },
  ];
  const as = async (id: string): Promise<PermissionSet> => {
    state.userId = id;
    return p(id);
  };
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  /** Meldung einer abgelehnten Rechtevergabe (ValidationError) – wirft, wenn nichts abgelehnt wurde */
  const refusal = async (run: Promise<unknown>): Promise<string> => {
    const err: unknown = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    return Object.values((err as ValidationError).fieldErrors).join(" ");
  };
  /** Aktivität im Notenbuch verbucht? (Sitzungszeile entsteht erst, wenn eine Prüfung hinter der Zugangsprüfung lief) */
  const touched = async (id: string) =>
    (
      await h.db
        .select()
        .from(notenbuchSessions)
        .where(eq(notenbuchSessions.userId, id))
    ).length;
  const snapshot = async () =>
    JSON.stringify([
      await h.db.select().from(notenbuchEntries),
      await h.db.select().from(notenbuchTermGrades),
      await h.db.select().from(notenbuchColumns),
      await h.db
        .select({
          id: notenbuchBooks.id,
          lockedAt: notenbuchBooks.lockedAt,
          weights: notenbuchBooks.weights,
        })
        .from(notenbuchBooks),
      await h.db.select().from(notenbuchBookTeachers),
    ]);

  beforeAll(async () => {
    h = await createSeededTestDb();
    state.db = h.db;
    [{ parentId: parent }] = (await h.db
      .select({ parentId: parentChild.parentId })
      .from(parentChild)
      .where(eq(parentChild.childId, LEA))) as [{ parentId: string }];
    // Mitschülerin der 7b (nicht Lea)
    const [o] = await h.db
      .select({ id: users.id, name: users.name })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(
        and(
          eq(groupMembers.groupId, "g-7b"),
          eq(users.role, "schueler"),
          ne(users.id, LEA),
        ),
      )
      .orderBy(users.id)
      .limit(1);
    other = o!.id;
    otherName = o!.name;

    const [b] = await h.db
      .insert(notenbuchBooks)
      .values({
        schoolYearId: YEAR,
        term: 1,
        groupId: "g-7b",
        subjectId: "D",
        scale: "noten6",
        weights: { schriftlich: 50, sonstige: 50 },
        lockedAt: new Date("2027-01-20T10:00:00Z"),
      })
      .returning({ id: notenbuchBooks.id });
    book = b!.id;
    await h.db
      .insert(notenbuchBookTeachers)
      .values({ bookId: book, teacherId: JANA });
    const [c] = await h.db
      .insert(notenbuchColumns)
      .values({
        bookId: book,
        kind: "sonstige",
        title: "Referat Balladen",
        date: "2026-10-01",
      })
      .returning({ id: notenbuchColumns.id });
    column = c!.id;
    await h.db.insert(notenbuchEntries).values([
      {
        columnId: column,
        studentId: LEA,
        value: "2",
        comment: "geheimer Kommentar",
      },
      {
        columnId: column,
        studentId: other,
        value: "5",
        comment: "fremde Note",
      },
    ]);
    await h.db.insert(notenbuchTermGrades).values([
      {
        bookId: book,
        studentId: LEA,
        computed: "2",
        final: "2",
        finalizedAt: NOW,
      },
      {
        bookId: book,
        studentId: other,
        computed: "5",
        final: "5",
        finalizedAt: NOW,
      },
    ]);

    // schlimmster Fall: Notenbuch-Rechte an Rolle und Klassengruppe (an der Rechteverwaltung vorbei), Hinweis bestätigt,
    // gültige Sitzung mit zweitem Faktor – nichts davon darf Schüler:innen oder Eltern etwas öffnen
    await h.db.insert(grants).values([
      { permission: "notenbuch.*", role: "schueler" },
      { permission: "notenbuch.*", role: "eltern" },
      { permission: "notenbuch.own", groupId: "g-7b" },
      { permission: "notenbuch.term_view", groupId: "g-7b" },
      { permission: "notenbuch.export", groupId: "g-7b" },
    ]);
    for (const id of [LEA, parent]) {
      await h.db
        .insert(notenbuchNoticeAcks)
        .values({ userId: id, version: NOTICE_VERSION, acknowledgedAt: NOW });
      await h.db.insert(sessions).values({
        id: `s-${id}`,
        token: `t-${id}`,
        userId: id,
        expiresAt: new Date("2030-01-01"),
        secondFactorAt: NOW,
      });
    }
  }, 60_000);
  afterAll(() => h.close());

  it("Ausgangslage: die Fehlkonfiguration ist wirklich da (Grants an Rolle und Gruppe)", async () => {
    expect([...(await p(LEA)).granted]).toEqual(
      expect.arrayContaining([
        "notenbuch.*",
        "notenbuch.own",
        "notenbuch.term_view",
        "notenbuch.export",
      ]),
    );
    expect([...(await p(parent)).granted]).toContain("notenbuch.*");
    expect(
      isFamilyRole("schueler") &&
        isFamilyRole("eltern") &&
        !isFamilyRole("lehrkraft"),
    ).toBe(true);
  });

  it("Rechteverwaltung: Notenbuch-Rechte lassen sich Schüler:innen und Eltern nicht geben – weder Rolle noch Gruppe mit ihnen", async () => {
    for (const role of ["schueler", "eltern"] as const) {
      for (const perm of [
        "notenbuch.own",
        "notenbuch.term_view",
        "notenbuch.export",
        "notenbuch.auskunft",
        "notenbuch.*",
      ]) {
        expect(
          await refusal(setRoleGrant(h.db, MODULES, ADMIN, role, perm, true)),
          `${role}/${perm}`,
        ).toMatch(/nie für Schüler:innen und Eltern/);
      }
    }
    for (const perm of ["notenbuch.term_view", "notenbuch.*"]) {
      expect(
        await refusal(addGroupGrant(h.db, MODULES, ADMIN, "g-7b", perm)),
        perm,
      ).toMatch(/solche Mitglieder/);
    }
    // nichts davon ist angekommen (nur die absichtlich vorab eingetragene Fehlkonfiguration)
    expect(
      (await h.db.select().from(grants)).filter(
        (g) =>
          (g.role === "schueler" || g.role === "eltern") &&
          (g.permission === "*" || g.permission.startsWith("notenbuch.")) &&
          g.permission !== "notenbuch.*",
      ),
    ).toEqual([]);
    // Gegenprobe: an Lehrkräfte bzw. eine reine Lehrkräfte-Gruppe geht es weiter
    await setRoleGrant(
      h.db,
      MODULES,
      ADMIN,
      "lehrkraft",
      "notenbuch.export",
      true,
    );
    await setRoleGrant(
      h.db,
      MODULES,
      ADMIN,
      "lehrkraft",
      "notenbuch.export",
      false,
    );
    await addGroupGrant(
      h.db,
      MODULES,
      ADMIN,
      "g-schulleitung",
      "notenbuch.term_view",
    );
  });

  for (const view of ["aus", "an"] as const) {
    describe(`Schüler-/Elternsicht ${view}`, () => {
      beforeAll(async () => {
        await writeModuleSetting(
          h.db,
          STUDENT_VIEW,
          view === "an" ? "teilnoten" : "aus",
        );
        await writeModuleSetting(
          h.db,
          PARENTS_VIEW,
          view === "an" ? "10" : "0",
        );
      });

      it("Rechte: kein Notenbuch-Recht, kein Zugang (auch mit Grant an Rolle/Gruppe)", async () => {
        for (const { who, id } of family()) {
          const perms = await p(id);
          for (const r of NOTENBUCH_RIGHTS)
            expect(hasNotenbuchRight(perms, r), `${who} ${r}`).toBe(false);
          expect(await notenbuchAccess(h.db, perms), who).toMatchObject({
            any: false,
            own: false,
            termView: false,
            transfer: false,
            export: false,
            unlock: false,
            classes: [],
          });
          expect(canOwnBooks(perms), who).toBe(false);
        }
      });

      it("Service: Bücher, Notentabelle, Spalten, Einträge, Abschluss, Übergabeliste, Übertragen, Entsperren, Export – alles zu", async () => {
        const before = await snapshot();
        for (const { who, id } of family()) {
          const perms = await p(id);
          expect(await ownBook(h.db, perms, book), who).toBeNull();
          expect(await getBook(h.db, perms, book), who).toBeNull();
          expect(await myBooks(h.db, perms), who).toEqual([]);
          expect(await bookOptions(h.db, perms, TODAY), who).toEqual([]);
          expect(await examOptions(h.db, perms, book), who).toEqual([]);
          expect(
            await termOverview(h.db, perms, "g-7b", NOW, {
              schoolYearId: YEAR,
              term: 1,
            }),
            who,
          ).toBeNull();
          expect(await handoverClasses(h.db, perms, "view"), who).toEqual([]);
          expect(await handoverClasses(h.db, perms, "export"), who).toEqual([]);
          const denied: [string, () => Promise<unknown>][] = [
            [
              "createBook",
              () =>
                createBook(
                  h.db,
                  perms,
                  { groupId: "g-7b", subjectId: "D", term: 2, scale: "noten6" },
                  TODAY,
                ),
            ],
            [
              "addColumn",
              () =>
                addColumn(h.db, perms, book, { kind: "sonstige", title: "X" }),
            ],
            [
              "updateColumn",
              () =>
                updateColumn(h.db, perms, column, {
                  kind: "sonstige",
                  title: "X",
                }),
            ],
            ["deleteColumn", () => deleteColumn(h.db, perms, column)],
            ["moveColumn", () => moveColumn(h.db, perms, column, 1)],
            [
              "setWeights",
              () =>
                setWeights(h.db, perms, book, {
                  schriftlich: 50,
                  sonstige: 50,
                }),
            ],
            [
              "addColumnFromExam",
              () => addColumnFromExam(h.db, perms, book, "e-x"),
            ],
            [
              "setEntry",
              () =>
                setEntry(h.db, perms, {
                  columnId: column,
                  studentId: LEA,
                  value: "1",
                }),
            ],
            ["setFinalGrade", () => setFinalGrade(h.db, perms, book, LEA, "1")],
            ["adoptSuggestions", () => adoptSuggestions(h.db, perms, book)],
            ["lockBook", () => lockBook(h.db, perms, book)],
            ["unlockBook", () => unlockBook(h.db, perms, book, "Grund")],
            ["lockedBooks", () => lockedBooks(h.db, perms)],
            ["transferTargets", () => transferTargets(h.db, perms)],
            ["booksForTransfer", () => booksForTransfer(h.db, perms)],
            [
              "transferBook",
              () => transferBook(h.db, perms, book, { toTeacherId: MURAT }),
            ],
            [
              "exportTermCsv",
              () =>
                exportTermCsv(
                  h.db,
                  perms,
                  "g-7b",
                  { schoolYearId: YEAR, term: 1 },
                  "utf8",
                ),
            ],
          ];
          for (const [name, run] of denied)
            await expect(run(), `${who} ${name}`).rejects.toBeInstanceOf(
              ForbiddenError,
            );
        }
        expect(await snapshot()).toBe(before);
      });

      it("Offline (P5-20): kein Einschalten, kein Schlüsselanteil, kein Abgleich", async () => {
        for (const { who, id } of family()) {
          const perms = await p(id);
          await expect(
            activateOfflineDevice(h.db, perms, new Headers(), {
              deviceId: DEVICE,
              sessionId: `s-${id}`,
              confirmed: true,
            }),
            who,
          ).rejects.toBeInstanceOf(ForbiddenError);
          expect(
            await offlineShare(h.db, perms, new Headers(), {
              deviceId: DEVICE,
              sessionId: `s-${id}`,
            }),
            who,
          ).toBeNull();
          const op = {
            opId: "11111111-2222-4333-8444-555555555555",
            columnId: column,
            studentId: LEA,
            value: "1",
            comment: null,
            baseVersion: 0,
            at: NOW.toISOString(),
          };
          await expect(
            syncOfflineOps(h.db, perms, book, [op], DEVICE),
            who,
          ).rejects.toBeInstanceOf(ForbiddenError);
        }
      });

      it("Server Actions: jede Notenbuch-Action bricht ab (Weiterleitung), bevor der Service läuft – nichts geändert", async () => {
        const before = await snapshot();
        for (const { who, id } of family()) {
          await as(id);
          const calls: [string, () => Promise<unknown>][] = [
            [
              "createBook",
              () =>
                actions.createBookAction(
                  {},
                  fd({ option: "g-7b|D", term: "2", scale: "noten6" }),
                ),
            ],
            [
              "addColumn",
              () =>
                actions.addColumnAction(book, { kind: "sonstige", title: "X" }),
            ],
            [
              "updateColumn",
              () =>
                actions.updateColumnAction(book, column, {
                  kind: "sonstige",
                  title: "X",
                }),
            ],
            ["deleteColumn", () => actions.deleteColumnAction(book, column)],
            ["moveColumn", () => actions.moveColumnAction(book, column, 1)],
            ["addExamColumn", () => actions.addExamColumnAction(book, "e-x")],
            [
              "setWeights",
              () =>
                actions.setWeightsAction(book, {
                  schriftlich: 50,
                  sonstige: 50,
                }),
            ],
            [
              "setEntry",
              () =>
                actions.setEntryAction({
                  columnId: column,
                  studentId: LEA,
                  value: "1",
                }),
            ],
            [
              "transferBook",
              () =>
                actions.transferBookAction(
                  book,
                  {},
                  fd({ toTeacherId: MURAT }),
                ),
            ],
            ["setFinal", () => actions.setFinalAction(book, LEA, "1")],
            ["adoptSuggestions", () => actions.adoptSuggestionsAction(book)],
            ["lockBook", () => actions.lockBookAction(book)],
            [
              "unlockBook",
              () => actions.unlockBookAction(book, {}, fd({ reason: "Grund" })),
            ],
            [
              "offlineActivate",
              () => actions.offlineActivateAction(DEVICE, true),
            ],
            ["offlineShare", () => actions.offlineShareAction(DEVICE)],
            [
              "offlineDeactivate",
              () => actions.offlineDeactivateAction(DEVICE),
            ],
            ["offlineSync", () => actions.offlineSyncAction(book, DEVICE, [])],
          ];
          for (const [name, run] of calls)
            await expect(run(), `${who} ${name}`).rejects.toThrow(
              "REDIRECT /notenbuch",
            );
          // Datenschutzhinweis bestätigen geht ebenfalls nicht (kein Zugang)
          await expect(
            acknowledgeNotice(h.db, await p(id)),
            who,
          ).rejects.toBeInstanceOf(ForbiddenError);
          // abgewiesen, bevor irgendetwas im Notenbuch lief (keine Aktivität verbucht)
          expect(await touched(id), who).toBe(0);
        }
        expect(await snapshot()).toBe(before);
      });

      it("CSV-Export (POST /api/notenbuch/export): 404 wie nicht vorhanden", async () => {
        for (const { who, id } of family()) {
          await as(id);
          const res = await exportPost(
            new Request("http://localhost/api/notenbuch/export", {
              method: "POST",
              body: fd({
                groupId: "g-7b",
                schoolYearId: YEAR,
                term: "1",
                encoding: "utf8",
              }),
            }),
          );
          expect(res.status, who).toBe(404);
          expect(await res.text(), who).not.toMatch(/Klasse;|Nachname/);
          // abgewiesen, bevor irgendetwas im Notenbuch lief (keine Aktivität verbucht)
          expect(await touched(id), who).toBe(0);
        }
      });

      it("Seiten: Notentabelle und Übergabeliste 404; die Übersicht nur mit eingeschalteter Sicht und dann nur eigene Noten", async () => {
        for (const { who, id } of family()) {
          const perms = await as(id);
          await expect(
            NotenbuchBookPage({ params: Promise.resolve({ id: book }) }),
            who,
          ).rejects.toThrow("NOT_FOUND");
          await expect(
            HandoverPage({
              params: Promise.resolve({ id: "g-7b" }),
              searchParams: Promise.resolve({}),
            }),
            who,
          ).rejects.toThrow("NOT_FOUND");
          if (view === "aus") {
            await expect(
              NotenbuchLayout({ children: "inhalt" }),
              who,
            ).rejects.toThrow("NOT_FOUND");
          } else {
            expect(await NotenbuchLayout({ children: "inhalt" }), who).toBe(
              "inhalt",
            );
            const page = (await NotenbuchPage()) as { type: unknown };
            expect(page.type, who).toBe(FamilyGrades);
            const json = JSON.stringify(await FamilyGrades({ perms }));
            expect(json, who).toContain("Referat Balladen");
            expect(json, who).not.toMatch(FOREIGN);
            expect(json, who).not.toContain(otherName);
          }
        }
      });

      it("Schüler-/Elternsicht (einsicht.ts): aus → nichts; an → nur eigene Noten, nie die der Mitschülerin", async () => {
        for (const { who, id } of family()) {
          const perms = await p(id);
          if (view === "aus") {
            expect(await gradeOwners(h.db, perms), who).toEqual([]);
            expect(await familyGrades(h.db, perms, LEA), who).toBeNull();
          } else {
            expect(
              (await gradeOwners(h.db, perms)).map((o) => o.id),
              who,
            ).toEqual([LEA]);
            const own = (await familyGrades(h.db, perms, LEA))!;
            expect(
              own.books.map((b) => [b.final, b.grades.map((g) => g.display)]),
              who,
            ).toEqual([["2", ["2"]]]);
            expect(JSON.stringify(own), who).not.toMatch(FOREIGN);
          }
          expect(await familyGrades(h.db, perms, other), who).toBeNull();
        }
      });

      it("Navigation: nie „Notenbuch“; „Noten“ nur mit eingeschalteter Sicht", async () => {
        const states = await loadModuleStates(h.db);
        const settings = new Map([
          ["notenbuch.student_view", view === "an" ? "teilnoten" : "aus"],
          ["notenbuch.parents_view", view === "an" ? "10" : "0"],
        ]);
        for (const { who, id } of family()) {
          const labels = buildNav([notenbuch], states, await p(id), {
            settings,
          })
            .flatMap((g) => g.items)
            .map((i) => i.label);
          expect(labels, who).toEqual(view === "an" ? ["Noten"] : []);
        }
      });

      it("Startseiten-Widget, Kursraum-Karte und Suche: nichts", async () => {
        const states = await loadModuleStates(h.db);
        for (const { who, id } of family()) {
          const perms = await p(id);
          expect(
            widgetsFor(notenbuchWidgets, MODULES, states, perms),
            who,
          ).toEqual([]);
          const current = {
            user: {
              id,
              name: "",
              firstName: "",
              lastName: "",
              shortCode: null,
              role: perms.role,
              username: "",
            },
            perms,
          };
          expect(
            await notenbuchWidgets[0]!.Component({ current } as never),
            who,
          ).toBeNull();
          expect(
            await ownBookLinks(h.db, perms, {
              groupId: "g-7b",
              currentOnly: true,
            }),
            who,
          ).toEqual([]);
          for (const q of ["7b", "Deutsch", "Klasse"])
            expect(
              await notenbuchSearch.search(h.db, current as never, q),
              `${who} ${q}`,
            ).toEqual([]);
        }
      });

      it("Auskunft (Art. 15) und Eigenexport: ohne Notenbuch-Teil für Schüler:innen/Eltern als Erzeugende; nie fremde Noten", async () => {
        for (const { who, id } of family()) {
          const perms = await p(id);
          expect(notenbuchAuskunft.restricted!.allowed(perms), who).toBe(false);
          // selbst erzeugt (falls je ein Weg dafür entstünde): Notenbuch-Teil fehlt, auch die Rohdaten
          const self = (await collectPersonalData(h.db, LEA, {
            actor: perms,
            secondFactor: true,
          }))!;
          expect(
            self.withheld.map((w) => w.module),
            who,
          ).toContain("notenbuch");
          expect(
            self.sections.map((s) => s.table),
            who,
          ).not.toEqual(expect.arrayContaining(["noten"]));
          expect(
            self.sections.some((s) =>
              [
                "noten",
                "halbjahresnoten",
                "notenbuch_entries",
                "notenbuch_term_grades",
              ].includes(s.table),
            ),
            who,
          ).toBe(false);
          expect(JSON.stringify(self.sections), who).not.toMatch(
            /geheimer Kommentar|fremde Note/,
          );
          // „Meine Dateien und Abgaben herunterladen“ enthält keine Noten
          expect(
            JSON.stringify(await planOwnExport(h.db, id)),
            who,
          ).not.toMatch(/Referat Balladen|geheimer|fremde/);
        }
        // die von der Schulleitung erteilte Auskunft über Lea enthält nur Leas Daten – nie die der Mitschülerin
        const lea = (await collectPersonalData(h.db, LEA, {
          actor: await p(PETRA),
          secondFactor: true,
        }))!;
        const json = JSON.stringify(lea.sections);
        expect(json).toContain("geheimer Kommentar");
        expect(json).not.toMatch(/fremde Note/);
        expect(json).not.toContain(otherName);
        // die Auskunft über das Elternkonto enthält keine Noten des Kindes
        const eltern = (await collectPersonalData(h.db, parent, {
          actor: await p(PETRA),
          secondFactor: true,
        }))!;
        expect(JSON.stringify(eltern.sections)).not.toMatch(
          /Referat Balladen|geheimer|fremde/,
        );
      });
    });
  }

  it("Gegenprobe: die führende Lehrkraft öffnet ihr Buch weiter (die Sperre trifft nur Schüler:innen und Eltern)", async () => {
    const jana = await p(JANA);
    expect(hasNotenbuchRight(jana, "notenbuch.own")).toBe(true);
    expect((await getBook(h.db, jana, book))?.book.id).toBe(book);
  });
});
