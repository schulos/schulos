import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  DISCLAIMER_LINES,
  DISCLAIMER_VERSION,
  disclaimerConfirmed,
} from "@schulos/server/disclaimer";
import { createSeededTestDb } from "@/core/db/testing";
import { appSettings, auditLog, users } from "@/core/db/schema";
import { ackDisclaimer, DISCLAIMER_KEY, readDisclaimerAck } from "./disclaimer";

describe("REPO-03: Vorschau-/Haftungshinweis", () => {
  it("Text nennt Vorschau, ohne Gewähr/Support, Verantwortung der Schule und was vor dem Echteinsatz fehlt", () => {
    const text = DISCLAIMER_LINES.join(" ");
    for (const s of [
      "Vorschau-Software",
      "ohne Gewähr",
      "ohne Support",
      "Verantwortlich für die Daten ist die Schule",
      "Penetrationstest",
      "Datenschutzbeauftragten",
      "Pilotbetrieb",
    ])
      expect(text).toContain(s);
    expect(disclaimerConfirmed(" verstanden ")).toBe(true);
    expect(disclaimerConfirmed("VERSTANDEN")).toBe(true);
    expect(disclaimerConfirmed("ja")).toBe(false);
    expect(disclaimerConfirmed("")).toBe(false);
  });

  it("Bestätigung je Fassung, idempotent, Audit mit Person – in den Einstellungen nur Fassung und Zeit", async () => {
    const h = await createSeededTestDb();
    const id = async (username: string) =>
      (
        await h.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, username))
      )[0]!.id;
    const admin = await id("admin");
    const other = await id("sabine.kowalski");
    expect(await readDisclaimerAck(h.db)).toBeNull();
    const at = new Date("2026-10-14T08:00:00Z");
    const ack = await ackDisclaimer(h.db, admin, at);
    expect(ack).toEqual({ version: DISCLAIMER_VERSION, at: at.toISOString() });
    expect(await readDisclaimerAck(h.db)).toEqual(ack);
    // zweites Mal: nichts Neues
    await ackDisclaimer(h.db, other, new Date("2026-10-15T08:00:00Z"));
    expect(await readDisclaimerAck(h.db)).toEqual(ack);
    const logs = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "system.disclaimer.ack"));
    expect(logs.map((l) => l.actorId)).toEqual([admin]);
    const [row] = await h.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, DISCLAIMER_KEY));
    expect(Object.keys(row!.value as object).sort()).toEqual(["at", "version"]);
    // ältere Fassung zählt nicht
    await h.db
      .update(appSettings)
      .set({ value: { version: DISCLAIMER_VERSION - 1, at: at.toISOString() } })
      .where(eq(appSettings.key, DISCLAIMER_KEY));
    expect(await readDisclaimerAck(h.db)).toBeNull();
    await h.close();
  });
});
