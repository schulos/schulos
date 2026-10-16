// Demo: Zuständigkeit Hausmeisterei für alle Kategorien, ein paar Meldungen in verschiedenen Status, Anlagen mit
// Prüfungen (eine überfällig, eine in 14 Tagen fällig) und eingeschaltete Prüfarten aus der Vorlage.
import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { gebaeudeAssets, gebaeudeInspections, gebaeudeInspectionTypes, gebaeudeResponsibilities, gebaeudeTicketEvents, gebaeudeTickets } from "@/core/db/schema";
import { addDays, toBerlinDate } from "@/core/time";
import { TICKET_CATEGORIES, type AssetKind } from "./labels";
import { addMonths, ensureTemplate, planDue } from "./pruefungen";

export async function seedGebaeude(db: Db, opts: { groupId: string; hausmeisterId: string; now?: Date }) {
  await db.insert(gebaeudeResponsibilities).values(TICKET_CATEGORIES.map((category) => ({ category, groupId: opts.groupId })));
  const now = opts.now ?? new Date();
  const year = Number(toBerlinDate(now).slice(0, 4));
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const tickets = [
    { seq: 1, category: "technik" as const, priority: "normal" as const, status: "in_arbeit" as const, roomId: "205", title: "Heizkörper wird nicht warm", description: "Seit Montag bleibt der Heizkörper unter dem Fenster kalt.", reporterId: "u-jana.brandt", assigneeId: opts.hausmeisterId, createdAt: ago(3) },
    { seq: 2, category: "gebaeude" as const, priority: "hoch" as const, status: "neu" as const, roomId: null, location: "Pausenhof, Westseite", title: "Gehwegplatte lose", description: "Stolperkante vor dem Fahrradständer.", reporterId: "u-sabine.kowalski", assigneeId: null, createdAt: ago(1) },
    { seq: 3, category: "it" as const, priority: "niedrig" as const, status: "erledigt" as const, roomId: "IF1", title: "Maus an Platz 7 fehlt", description: "", reporterId: "u-jana.brandt", assigneeId: opts.hausmeisterId, createdAt: ago(10), closedAt: ago(8) },
  ];
  for (const t of tickets) {
    const [row] = await db
      .insert(gebaeudeTickets)
      .values({ year, location: null, ...t, updatedAt: t.closedAt ?? t.createdAt })
      .returning({ id: gebaeudeTickets.id });
    await db.insert(gebaeudeTicketEvents).values({ ticketId: row!.id, actorId: t.reporterId, kind: "status", statusTo: "neu", at: t.createdAt });
    if (t.status !== "neu") {
      await db.insert(gebaeudeTicketEvents).values({ ticketId: row!.id, actorId: opts.hausmeisterId, kind: "status", statusFrom: "neu", statusTo: t.status, at: t.closedAt ?? ago(2) });
    }
  }
  await seedInspections(db, toBerlinDate(now));
}

/** Demo-Anlagen und Prüfungen relativ zu „heute“: Leiter überfällig, Feuerlöscher in 14 Tagen fällig, Rest geplant. */
async function seedInspections(db: Db, today: string) {
  await ensureTemplate(db);
  const active = ["elektro-ortsveraenderlich", "feuerloescher", "leitern", "erste-hilfe", "brandschutz-technik", "begehung-arbeitsschutz"];
  await db.update(gebaeudeInspectionTypes).set({ active: true }).where(inArray(gebaeudeInspectionTypes.templateKey, active));
  const types = new Map((await db.select({ id: gebaeudeInspectionTypes.id, key: gebaeudeInspectionTypes.templateKey }).from(gebaeudeInspectionTypes)).map((t) => [t.key, t.id]));
  const assets: { name: string; kind: AssetKind; roomId: string | null; building?: string; inventoryNo: string; type: string; months: number; lastDone: string }[] = [
    // zuletzt geprüft: so gewählt, dass die nächste Prüfung in 14 Tagen bzw. vor 20 Tagen fällig ist
    { name: "Feuerlöscher Flur EG", kind: "feuerloescher", roomId: null, building: "Hauptgebäude", inventoryNo: "FL-001", type: "feuerloescher", months: 24, lastDone: addMonths(addDays(today, 14), -24) },
    { name: "Feuerlöscher Chemie", kind: "feuerloescher", roomId: "NW2", inventoryNo: "FL-002", type: "feuerloescher", months: 24, lastDone: addMonths(today, -6) },
    { name: "Stehleiter 6 Stufen", kind: "leiter", roomId: null, building: "Sporthalle", inventoryNo: "LE-001", type: "leitern", months: 12, lastDone: addMonths(addDays(today, -20), -12) },
    { name: "Beamer", kind: "elektro_ortsveraenderlich", roomId: "106", inventoryNo: "EL-106-1", type: "elektro-ortsveraenderlich", months: 24, lastDone: addMonths(today, -10) },
    { name: "Verbandkasten Sporthalle", kind: "erste_hilfe", roomId: "TH1", inventoryNo: "EH-001", type: "erste-hilfe", months: 12, lastDone: addMonths(today, -3) },
  ];
  for (const a of assets) {
    const [row] = await db
      .insert(gebaeudeAssets)
      .values({ name: a.name, kind: a.kind, roomId: a.roomId, building: a.building ?? null, inventoryNo: a.inventoryNo })
      .returning({ id: gebaeudeAssets.id });
    await db.insert(gebaeudeInspections).values({ typeId: types.get(a.type)!, assetId: row!.id, dueOn: a.lastDone, doneOn: a.lastDone, result: "ok", company: "Prüfdienst Rhein-Ruhr GmbH" });
  }
  await planDue(db, today);
  await db.insert(gebaeudeInspections).values({ typeId: types.get("brandschutz-technik")!, building: "Hauptgebäude", dueOn: addDays(today, 75) });
  // Inventar ohne aktive Prüfart (Lüftung) bleibt ohne Prüfung
  await db.insert(gebaeudeAssets).values({ name: "Lüftungsanlage Pavillon", kind: "lueftung", building: "Pavillon", inventoryNo: "LU-001" });
}
