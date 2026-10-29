// RS-11: Kurz-URL-Codes je Ziel (gemeinsamer Unterbau Tür-QR/Inventar). Ohne Rechteprüfung – die prüft die Fachseite (Raum:
// `src/modules/verwaltung/tuer-qr.ts`). Je Ziel genau ein gültiger Code; Neuerzeugen ersetzt ihn (alter Code sofort ungültig).
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { labelCodes } from "@/core/db/schema";
import { newLabelCode, normalizeLabelCode, type LabelKind } from "./codes";

/** Zielspalte je Art – eine neue Art bekommt eine eigene Spalte in `label_codes`. */
const TARGET = { raum: labelCodes.roomId } as const satisfies Record<LabelKind, unknown>;

const targetValues = (kind: LabelKind, targetId: string) => ({ kind, ...(kind === "raum" ? { roomId: targetId } : {}) });

/** Vorhandene Codes je Ziel (Ziel-ID → Code). */
export async function labelCodesFor(db: Db, kind: LabelKind, targetIds: readonly string[]): Promise<Map<string, string>> {
  if (!targetIds.length) return new Map();
  const col = TARGET[kind];
  const rows = await db
    .select({ target: col, code: labelCodes.code })
    .from(labelCodes)
    .where(and(eq(labelCodes.kind, kind), inArray(col, [...targetIds])));
  return new Map(rows.flatMap((r) => (r.target ? [[r.target, r.code] as const] : [])));
}

/**
 * Codes für Ziele ohne Code anlegen; vorhandene bleiben (stabil). Liefert alle Codes und die neu angelegten Ziel-IDs. Bei einer
 * (praktisch ausgeschlossenen) Kollision wird neu gewürfelt; gleichzeitiges Anlegen für dasselbe Ziel gewinnt einmal.
 */
export async function ensureLabelCodes(db: Db, kind: LabelKind, targetIds: readonly string[]): Promise<{ codes: Map<string, string>; created: string[] }> {
  const codes = await labelCodesFor(db, kind, targetIds);
  const created: string[] = [];
  for (const id of new Set(targetIds)) {
    if (codes.has(id)) continue;
    for (let i = 0; i < 5 && !codes.has(id); i++) {
      const [row] = await db
        .insert(labelCodes)
        .values({ code: newLabelCode(), ...targetValues(kind, id) })
        .onConflictDoNothing()
        .returning({ code: labelCodes.code });
      if (row) {
        codes.set(id, row.code);
        created.push(id);
      } else {
        const again = (await labelCodesFor(db, kind, [id])).get(id);
        if (again) codes.set(id, again);
      }
    }
    if (!codes.has(id)) throw new Error("Etikett-Code: kein freier Zufallscode");
  }
  return { codes, created };
}

/** Neuen Code für ein Ziel erzeugen – der bisherige ist danach ungültig. */
export async function renewLabelCode(db: Db, kind: LabelKind, targetId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.delete(labelCodes).where(and(eq(labelCodes.kind, kind), eq(TARGET[kind], targetId)));
    for (let i = 0; i < 5; i++) {
      const [row] = await tx
        .insert(labelCodes)
        .values({ code: newLabelCode(), ...targetValues(kind, targetId) })
        .onConflictDoNothing()
        .returning({ code: labelCodes.code });
      if (row) return row.code;
    }
    throw new Error("Etikett-Code: kein freier Zufallscode");
  });
}

/**
 * Kurz-URL auflösen: Ziel-ID oder `null` (unbekannt, falsche Art, kein Code-Format). Nur nach der Anmeldung aufrufen – vorher
 * darf die Antwort nicht von der Gültigkeit des Codes abhängen (`/r/[code]`).
 */
export async function resolveLabelCode(db: Db, kind: LabelKind, input: string): Promise<string | null> {
  const code = normalizeLabelCode(input);
  if (!code) return null;
  const col = TARGET[kind];
  const [row] = await db
    .select({ target: col })
    .from(labelCodes)
    .where(and(eq(labelCodes.code, code), eq(labelCodes.kind, kind)));
  return row?.target ?? null;
}
