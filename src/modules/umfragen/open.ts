// „Offen für dich“ (Q5-07): Umfragen, die sich an die Person richten und noch nicht beantwortet sind (keine Schnellumfragen).
import type { OpenItemsProvider } from "@/core/open-items";
import { listForParticipant } from "./service";

export const umfragenOpen: OpenItemsProvider = {
  moduleId: "umfragen",
  async collect(db, { perms }, now) {
    const open = (await listForParticipant(db, perms, now)).filter((s) => !s.participated && s.status === "offen");
    if (open.length === 0) return [];
    return [
      {
        id: "umfragen:offen",
        moduleId: "umfragen",
        label: open.length === 1 ? "Umfrage beantworten" : "Umfragen beantworten",
        count: open.length,
        detail: open
          .slice(0, 2)
          .map((s) => s.title)
          .join(" · ") + (open.length > 2 ? " …" : ""),
        href: open.length === 1 ? `/umfragen/${open[0]!.id}` : "/umfragen",
        tone: "info",
      },
    ];
  },
};
