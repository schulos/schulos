// „Offen für dich“ (Q5-07): Vertretungsplanung (`stundenplan.substitute`, SP-02) – offener Vertretungsbedarf heute bzw. am nächsten
// Schultag und am Tag danach, unbesetzte Pausenaufsichten, Vertretungsplan-Entwürfe (Q5-11), Raumsperren heute.
// Lehrkraft – Zeitwünsche abgeben, solange das Eingabefenster offen ist (Q5-10). Nur Zähler, keine Auswertung je Lehrkraft.
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { hasPermission } from "@/core/permissions";
import type { OpenItem, OpenItemsProvider } from "@/core/open-items";
import { needsOn } from "./abwesenheit";
import { dutiesOn } from "./aufsichten";
import { openDrafts } from "./freigabe";
import { blocksOn } from "./raumsperren";
import { planDays } from "./vertretung";
import { formatDay, ownSubmissionOpen } from "./zeitwunsch-fenster";

const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const dayLabel = (ymd: string) => shortDay.format(fromBerlinLocal(ymd));

export const stundenplanOpen: OpenItemsProvider = {
  moduleId: "stundenplan",
  async collect(db, { perms }, now) {
    const today = toBerlinDate(now);
    const out: OpenItem[] = [];
    if (perms.role === "lehrkraft") {
      const prefs = await ownSubmissionOpen(db, perms.userId, today);
      if (prefs && !prefs.submitted)
        out.push({
          id: "stundenplan:zeitwuensche",
          moduleId: "stundenplan",
          label: `Zeitwünsche abgeben bis ${formatDay(prefs.window.closesOn)}`,
          href: "/stundenplan/zeitwuensche",
          tone: "warn",
        });
    }
    if (!hasPermission(perms, "stundenplan.substitute")) return out;

    const days = planDays(today, await loadSchoolCalendar(db));
    const [needs, duties, drafts, blocks] = await Promise.all([Promise.all(days.map((d) => needsOn(db, d))), dutiesOn(db, days[0]), openDrafts(db, today), blocksOn(db, today)]);
    const openPerDay = days.map((d, i) => ({ d, n: needs[i]!.open.filter((o) => o.status === "open").length })).filter((x) => x.n > 0);
    const openTotal = openPerDay.reduce((s, x) => s + x.n, 0);
    if (openTotal > 0)
      out.push({
        id: "stundenplan:bedarf",
        moduleId: "stundenplan",
        label: "Vertretungsbedarf offen",
        count: openTotal,
        detail: openPerDay.map((x) => `${dayLabel(x.d)}: ${x.n}`).join(" · "),
        href: `/planung/vertretungen?datum=${openPerDay[0]!.d}`,
        tone: "danger",
      });
    const openDuties = duties.filter((d) => d.status === "open").length;
    if (openDuties > 0)
      out.push({
        id: "stundenplan:aufsichten",
        moduleId: "stundenplan",
        label: openDuties === 1 ? "Aufsicht unbesetzt" : "Aufsichten unbesetzt",
        count: openDuties,
        detail: dayLabel(days[0]),
        href: `/planung/aufsichten?datum=${days[0]}`,
        tone: "danger",
      });
    if (drafts.length > 0)
      out.push({
        id: "stundenplan:entwurf",
        moduleId: "stundenplan",
        label: "Vertretungsplan nicht veröffentlicht",
        count: drafts.length,
        detail: drafts.slice(0, 3).map(dayLabel).join(" · "),
        href: `/planung/vertretungen?datum=${drafts[0]}`,
        tone: "warn",
      });
    if (blocks.length > 0)
      out.push({
        id: "stundenplan:raumsperren",
        moduleId: "stundenplan",
        label: blocks.length === 1 ? "Raum heute gesperrt" : "Räume heute gesperrt",
        count: blocks.length,
        detail: [...new Set(blocks.map((b) => b.roomId))].slice(0, 5).join(", "),
        href: "/stundenplan/raeume?ansicht=sperrungen",
        tone: "info",
      });
    return out;
  },
};
