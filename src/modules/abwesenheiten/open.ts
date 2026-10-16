// „Offen für dich“ (Q5-07): Eltern – eigene Krankmeldungen, über die die Klassenleitung noch nicht entschieden hat;
// Klassenleitung (bzw. `abwesenheiten.manage`) – Meldungen der eigenen Klassen, die auf die Entscheidung warten.
// Q5-16: Beurlaubungen – Eltern „beantragt“, Klassenleitung bis zur Grenze, Schulleitung darüber.
import type { OpenItem, OpenItemsProvider } from "@/core/open-items";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { leaderLeaves, leaveDecidersMissing, leavesFor, principalLeaves } from "./beurlaubung";
import { leaderView, parentView } from "./service";

const firstNames = (names: string[]) => [...new Set(names.map((n) => n.split(" ")[0]))].join(", ");

export const abwesenheitenOpen: OpenItemsProvider = {
  moduleId: "abwesenheiten",
  async collect(db, { perms }, now) {
    const today = toBerlinDate(now);
    const out: OpenItem[] = [];
    if (perms.role === "eltern") {
      const { kids, reports } = await parentView(db, perms.userId);
      const open = reports.filter((r) => r.status === "gemeldet");
      if (open.length > 0) {
        out.push({
          id: "abwesenheiten:gemeldet",
          moduleId: "abwesenheiten",
          label: open.length === 1 ? "Krankmeldung noch nicht entschieden" : "Krankmeldungen noch nicht entschieden",
          count: open.length,
          detail: firstNames(open.map((r) => r.studentName)),
          href: "/abwesenheiten",
          tone: "info",
        });
      }
      // GATE-4f S-02: nur minderjährige Kinder (I-05) – `parentView` liefert eigenständige gar nicht (DS-19)
      const minors = kids.map((k) => k.id);
      const leaves = minors.length ? (await leavesFor(db, minors)).filter((l) => l.status === "beantragt") : [];
      if (leaves.length > 0) {
        out.push({
          id: "abwesenheiten:beurlaubung-beantragt",
          moduleId: "abwesenheiten",
          label: leaves.length === 1 ? "Beurlaubung noch nicht entschieden" : "Beurlaubungen noch nicht entschieden",
          count: leaves.length,
          detail: firstNames(leaves.map((l) => l.studentName)),
          href: "/abwesenheiten",
          tone: "info",
        });
      }
      return out;
    }
    if (!["lehrkraft", "verwaltung", "admin"].includes(perms.role)) return [];
    const { students, reports } = await leaderView(db, perms);
    const open = reports.filter((r) => r.status === "gemeldet");
    if (open.length > 0) {
      out.push({
        id: "abwesenheiten:entscheiden",
        moduleId: "abwesenheiten",
        label: open.length === 1 ? "Krankmeldung entscheiden" : "Krankmeldungen entscheiden",
        count: open.length,
        detail: [...new Set(open.map((r) => r.groupName).filter(Boolean))].join(", ") || undefined,
        href: "/abwesenheiten",
        tone: "warn",
      });
    }
    // GATE-4f C-06: Schulleitung, die zugleich Klassenleitung ist, sieht beides (nach Antrag zusammengeführt)
    const sl = hasPermission(perms, "abwesenheiten.leave_decide");
    const byId = new Map<string, { groupName: string | null }>();
    if (sl) for (const l of await principalLeaves(db, perms, today)) if (l.status === "beantragt") byId.set(l.id, l);
    if (students.length) for (const l of await leaderLeaves(db, perms, students.map((s) => s.id))) if (l.canDecide) byId.set(l.id, l);
    const leaves = [...byId.values()];
    if (leaves.length > 0) {
      out.push({
        id: "abwesenheiten:beurlaubung",
        moduleId: "abwesenheiten",
        label: leaves.length === 1 ? "Beurlaubung entscheiden" : "Beurlaubungen entscheiden",
        count: leaves.length,
        detail: [...new Set(leaves.map((l) => l.groupName).filter(Boolean))].join(", ") || undefined,
        href: "/abwesenheiten",
        tone: "warn",
      });
    }
    // GATE-4f C-10: das Recht für Beurlaubungen über der Grenze hat außer Admins niemand – wer Rechte vergibt, erfährt es
    if (hasPermission(perms, "verwaltung.rights") && (await leaveDecidersMissing(db))) {
      out.push({
        id: "abwesenheiten:leave-decide-fehlt",
        moduleId: "abwesenheiten",
        label: "Recht für Beurlaubungen über der Grenze vergeben",
        detail: "„Beurlaubungen über der Grenze entscheiden“ hat außer Admin-Konten niemand – z. B. der Gruppe Schulleitung geben",
        href: "/verwaltung/rechte",
        tone: "warn",
      });
    }
    return out;
  },
};
