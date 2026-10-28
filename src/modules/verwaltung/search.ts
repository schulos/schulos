import { roomHref } from "@/core/room-href";
import type { SearchProvider } from "@/core/search";
import { roomDirectory } from "./raumsteckbrief";

/** RS-02: Räume nach Kürzel oder Name → Raumsteckbrief (alle Angemeldeten; nur aktive Räume, keine Personendaten). */
export const raeumeSearch: SearchProvider = {
  moduleId: "verwaltung",
  async search(db, _current, q) {
    const rows = await roomDirectory(db, q, 5);
    return rows.map((r) => ({
      group: "Räume",
      id: `raum:${r.id}`,
      title: r.name === r.id || r.name === `Raum ${r.id}` ? `Raum ${r.id}` : `${r.id} – ${r.name}`,
      subtitle: [r.building, r.floor].filter(Boolean).join(", ") || undefined,
      href: roomHref(r.id),
      icon: "DoorOpen",
    }));
  },
};
