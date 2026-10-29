import type { Db } from "@/core/db/client";
import { hilfePages, hilfeSections, hilfeTargets } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
import { addMonths, STAFF_TARGET_ROLES } from "./service";
import { STARTER_PAGES, STARTER_SECTION } from "./starter";

/**
 * Demo-Handbuch (HB-01): ein Bereich mit zwei neutralen Beispielseiten – eine für alle, eine nur für Personal, deren
 * Überprüfung fällig ist (Widget für das Sekretariat). Dazu die Starter-Seiten (HB-07) im Bereich „Erste Schritte“ – in einer frischen Installation legt sie ein Klick im Handbuch an.
 */
export async function seedHilfe(db: Db, now = new Date()) {
  const today = toBerlinDate(now);
  await db.insert(hilfeSections).values({ id: "hilfe-alltag", title: "Schulalltag", position: 0 });
  await db.insert(hilfePages).values([
    {
      id: "hilfe-fundsachen",
      sectionId: "hilfe-alltag",
      slug: "fundsachen",
      title: "Fundsachen",
      body: "Gefundene Sachen bitte im **Sekretariat** abgeben.\n\n## Abholen\n\n- montags bis freitags in der ersten großen Pause\n- Nicht abgeholte Sachen werden vor den Sommerferien gespendet.\n\nFragen beantwortet das Sekretariat.",
      position: 0,
      status: "veroeffentlicht",
      contactId: "u-sabine.kowalski",
      createdBy: "u-sabine.kowalski",
      updatedBy: "u-sabine.kowalski",
      reviewedOn: today,
    },
    {
      id: "hilfe-kopierer",
      sectionId: "hilfe-alltag",
      slug: "kopierer-im-lehrerzimmer",
      title: "Kopierer im Lehrerzimmer",
      body: "Der Kopierer im Lehrerzimmer druckt und scannt.\n\n1. Am Gerät mit dem Kürzel anmelden.\n2. Bei Papierstau die Klappe rechts öffnen.\n3. Störungen über **Gebäude & Technik** melden.\n\nSiehe auch: [Fundsachen](/hilfe/fundsachen)",
      position: 1,
      status: "veroeffentlicht",
      contactId: "u-sabine.kowalski",
      createdBy: "u-sabine.kowalski",
      updatedBy: "u-sabine.kowalski",
      // Demo: Überprüfung seit einem Monat fällig (Vorgabe 12 Monate)
      reviewedOn: addMonths(today, -13),
      reviewRemindedAt: now,
    },
  ]);
  await db.insert(hilfeTargets).values(STAFF_TARGET_ROLES.map((role) => ({ pageId: "hilfe-kopierer", role })));
  // Starter-Seiten (HB-07): wie nach „Starter-Seiten anlegen“, veröffentlicht für ihre Zielgruppen
  await db.insert(hilfeSections).values({ id: "hilfe-erste-schritte", title: STARTER_SECTION, position: 1 });
  await db.insert(hilfePages).values(
    STARTER_PAGES.map((p, i) => ({
      id: `hilfe-starter-${p.slug}`,
      sectionId: "hilfe-erste-schritte",
      slug: p.slug,
      title: p.title,
      body: p.body,
      position: i,
      status: "veroeffentlicht" as const,
      createdBy: "u-sabine.kowalski",
      updatedBy: "u-sabine.kowalski",
      reviewedOn: today,
    })),
  );
  await db.insert(hilfeTargets).values(STARTER_PAGES.flatMap((p) => p.roles.map((role) => ({ pageId: `hilfe-starter-${p.slug}`, role }))));
}
