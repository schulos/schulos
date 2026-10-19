// GATE BU1 (Schulbücherei Stufe 1): Querschnittsprüfung über alle Bücherei-Tabellen. Nach einem vollständigen Durchlauf –
// Vormerkung, Ausleihe, Erinnerung, Mahnung (mit Eltern und Mail), Verlängern, Rückgabe ohne Befund, Nachrücken der Vormerkung,
// Ausleihe an die vormerkende Person und deren Rückgabe – hängt an keiner Bücherei-Zeile mehr eine Person (außer dem
// Büchereiausweis, der zum Konto gehört), Zähler und Exemplar-Spalten tragen nur Zahlen und Monate, Benachrichtigungen und Mails
// nennen keinen Titel. Außerdem: gleichzeitiges Verbuchen desselben Exemplars endet als Meldung, nicht als Serverfehler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { auditLog, buechereiCopies, buechereiLoans, buechereiReservations, buechereiStats, mailOutbox, notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { ensureCards } from "./cards";
import { dueDate } from "./dates";
import { checkin, checkout, renewLoan } from "./loans";
import { runDunning } from "./mahnungen";
import { reserve } from "./reservations";
import { createTitle } from "./service";
import { DUNNING_MAIL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung (Theke + Bestand)
const JANA = "u-jana.brandt"; // Lehrkraft: merkt vor
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const TITLE = "Gate-Probe Verborgenes Tagebuch";

describe("GATE BU1 – Bücherei ohne Leseprofil", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Alle Zeilen aller Tabellen `buecherei_*` als JSON-Text, je Tabelle. */
  async function allLibraryRows(): Promise<Map<string, string[]>> {
    const tables = rowsOf<{ name: string }>(await h.db.execute(sql`select tablename as name from pg_tables where schemaname = 'public' and tablename like 'buecherei\_%' order by tablename`));
    const out = new Map<string, string[]>();
    for (const { name } of tables) {
      const rows = rowsOf<{ j: string }>(await h.db.execute(sql`select row_to_json(t)::text as j from ${sql.identifier(name)} t`));
      out.set(
        name,
        rows.map((r) => r.j),
      );
    }
    return out;
  }

  it("nach Rückgabe ohne Befund hängt an keiner Bücherei-Zeile mehr eine Person; Gong und Mail ohne Titel", async () => {
    const desk = await p(SABINE);
    await h.db.update(users).set({ email: "lea@example.org", emailVerified: true }).where(eq(users.id, LEA));
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, MUTTER));
    await writeModuleSetting(h.db, DUNNING_MAIL, "1");
    // Demo-Ausleihen/-Vormerkungen der beiden aus dem Weg räumen (die Prüfung gilt dem eigenen Durchlauf)
    for (const id of [LEA, JANA]) {
      for (const l of await h.db.select({ id: buechereiLoans.id, copyId: buechereiLoans.copyId }).from(buechereiLoans).where(eq(buechereiLoans.userId, id)))
        await h.db.delete(buechereiLoans).where(eq(buechereiLoans.id, l.id));
      await h.db.delete(buechereiReservations).where(eq(buechereiReservations.userId, id));
    }
    // Ausweis gehört zum Konto (LK-KONTO) – bleibt bewusst, darf aber nichts über Ausleihen verraten
    await ensureCards(h.db, desk, [LEA, JANA]);

    const day = await dueDate(h.db, "2026-11-09", 0); // ein Schultag
    const { barcodes } = await createTitle(h.db, desk, { title: TITLE, mediaType: "buch" }, { count: 1 });
    const code = barcodes[0]!;
    const [copy] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, code));

    // Lea leiht aus, Jana merkt vor, Lea verlängert nicht (Vormerkung) → überfällig, erinnert und zweimal gemahnt
    await checkout(h.db, desk, LEA, code, addDays(day, -40));
    const r = await reserve(h.db, await p(JANA), copy!.titleId);
    expect(r.position).toBe(1);
    const [loan] = await h.db.select().from(buechereiLoans).where(eq(buechereiLoans.copyId, copy!.id));
    await expect(renewLoan(h.db, desk, loan!.id, day)).rejects.toBeInstanceOf(ValidationError);
    await h.db.update(buechereiLoans).set({ dueOn: addDays(day, 1) }).where(eq(buechereiLoans.id, loan!.id));
    await runDunning(h.db, day, { mail: true, school: "Testschule" }); // Erinnerung
    await h.db.update(buechereiLoans).set({ dueOn: addDays(day, -8), dunningLevel: 1, dunnedOn: addDays(day, -7) }).where(eq(buechereiLoans.id, loan!.id));
    expect(await runDunning(h.db, day, { mail: true, school: "Testschule" })).toMatchObject({ dunned: 1, parents: 1 });

    // Rückgabe ohne Befund → Janas Vormerkung rückt nach; Jana leiht aus und gibt zurück
    expect(await checkin(h.db, desk, code, day)).toMatchObject({ finding: false });
    await checkout(h.db, desk, JANA, code, day);
    await checkin(h.db, desk, code, day);

    // 1. Keine Bücherei-Zeile nennt Lea oder Jana – außer dem Ausweis (Code je Konto, ohne Ausleihbezug)
    const rows = await allLibraryRows();
    expect([...rows.keys()]).toEqual(expect.arrayContaining(["buecherei_cards", "buecherei_copies", "buecherei_loans", "buecherei_reservations", "buecherei_stats", "buecherei_titles"]));
    for (const [table, list] of rows) {
      if (table === "buecherei_cards") {
        for (const j of list.filter((x) => x.includes(LEA) || x.includes(JANA))) expect(Object.keys(JSON.parse(j) as object).sort()).toEqual(["code", "created_at", "user_id"]);
        continue;
      }
      for (const j of list) {
        expect(j, table).not.toContain(LEA);
        expect(j, table).not.toContain(JANA);
      }
    }
    // Exemplar: nur Zahl und Monat; Zähler: nur Monat, Medienart, Zahlen
    const [after] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.id, copy!.id));
    expect(after).toMatchObject({ loanCount: 2, lastLoanMonth: day.slice(0, 7), labelPrintedAt: null });
    const statCols = Object.keys((await h.db.select().from(buechereiStats).limit(1))[0]!).sort();
    expect(statCols).toEqual(["dunnings", "loans", "mediaType", "month", "renewals"]);
    // Audit-Log: Ausleihe und Rückgabe stehen dort nicht
    const audits = await h.db.select({ action: auditLog.action, target: auditLog.target, meta: auditLog.meta }).from(auditLog).where(like(auditLog.action, "buecherei.%"));
    expect(audits.filter((a) => [a.target, JSON.stringify(a.meta ?? "")].some((x) => x?.includes(LEA) || x?.includes(code)))).toEqual([]);

    // 3. Gong und Mail: es gab Erinnerung, Mahnung (auch an die Mutter) und „Vormerkung bereit“ – keine nennt den Titel
    const gongs = await h.db.select({ userId: notifications.userId, title: notifications.title, body: notifications.body }).from(notifications).where(eq(notifications.moduleId, "buecherei"));
    for (const id of [LEA, MUTTER, JANA]) expect(gongs.some((g) => g.userId === id), id).toBe(true);
    for (const g of gongs) expect(`${g.title} ${g.body}`).not.toContain(TITLE);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "buecherei-mahnung"));
    expect(mails.map((m) => m.to).sort()).toEqual(["lea@example.org", "mutter@example.org"]);
    for (const m of mails) expect(`${m.subject} ${m.text}`).not.toContain(TITLE);
  });

  it("gleichzeitig dasselbe Exemplar an zwei Personen: genau eine Ausleihe, die andere bekommt eine Meldung", async () => {
    const desk = await p(SABINE);
    const { barcodes } = await createTitle(h.db, desk, { title: "Gate-Probe Gleichzeitig", mediaType: "buch" }, { count: 1 });
    const code = barcodes[0]!;
    const day = await dueDate(h.db, "2026-11-10", 0);
    const results = await Promise.allSettled([checkout(h.db, desk, LEA, code, day), checkout(h.db, desk, JANA, code, day)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x) => x.status === "rejected");
    expect(failed && failed.reason).toBeInstanceOf(ValidationError);
    const [c] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, code));
    expect(c!.loanCount).toBe(1);
    expect(await h.db.select().from(buechereiLoans).where(eq(buechereiLoans.copyId, c!.id))).toHaveLength(1);
  });
});
