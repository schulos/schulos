import type { Db } from "@/core/db/client";
import { newsPosts, newsTargets } from "@/core/db/schema";

const DAY = 86_400_000;

/** Beispielbeiträge für die Demo-Schule. Zeiten relativ zu „jetzt", Inhalte fest. */
export async function seedNews(db: Db, now = new Date()) {
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  const posts = [
    {
      id: "news-herbstferien",
      authorId: "u-petra.lindner",
      title: "Herbstferien: Notbetreuung bis 9.10. anmelden",
      body: "Liebe Eltern,\n\nin den Herbstferien bieten wir für die Jahrgänge **5 und 6** eine Notbetreuung an (8–13 Uhr, Raum 101).\n\nBitte meldet euren Bedarf bis **Freitag, 9. Oktober** im Sekretariat an.",
      pinned: true,
      publishedAt: at(2),
      targets: [{ role: "eltern" as const }, { role: "lehrkraft" as const }],
    },
    {
      id: "news-mensa",
      authorId: "u-sabine.kowalski",
      title: "Neuer Speiseplan für die Woche ist online",
      body: "Der Speiseplan hängt wie immer neben der Mensa aus. Neu: jeden Mittwoch ein **vegetarisches Pastagericht**.",
      pinned: false,
      onMonitor: true,
      publishedAt: at(0.1),
      targets: [],
    },
    {
      id: "news-elternabend-7b",
      authorId: "u-jana.brandt",
      title: "Elternabend der 7b am 13.10.",
      body: "Der Elternabend der Klasse 7b findet am **Dienstag, 13. Oktober um 19 Uhr** in Raum 112 statt.\n\nThemen:\n- Wandertag\n- Klassenfahrt im Frühjahr\n- Wahl der Klassenpflegschaft",
      pinned: false,
      publishedAt: at(1),
      targets: [{ groupId: "g-7b" }],
    },
    {
      id: "news-schuelerzeitung",
      authorId: "u-jana.brandt",
      title: "Schülerzeitung: Redaktionsschluss für die Herbstausgabe",
      body: "Alle Artikel bitte bis zum **16. Oktober** abgeben. Fotos gern im Querformat.",
      pinned: false,
      publishedAt: at(3),
      targets: [{ groupId: "g-ag-schuelerzeitung" }],
    },
  ];
  for (const { targets, ...p } of posts) {
    await db.insert(newsPosts).values(p);
    if (targets.length) await db.insert(newsTargets).values(targets.map((t) => ({ postId: p.id, ...t })));
  }
}
