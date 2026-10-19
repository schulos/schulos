// SP-12 (Hinweis aus SP-05): „Offen für dich“ hängt nicht an einer Rollenliste – auch Personal und Beratung (etwa mit der
// Funktionsgruppe Stundenplanung) sehen es; den Inhalt bestimmen die Lieferanten nach Rechten.
import { describe, expect, it, vi } from "vitest";
import type { PermissionSet } from "@/core/permissions";
import { ROLES } from "@/core/roles";
import { widgetsFor } from "@/core/widgets";
import { MODULES } from "@/modules";
import { heuteWidgets } from "./widgets";

// widgets.tsx zieht Server Actions nach (Elternbrief „Erinnern“) – hier geht es nur um die Sichtbarkeitsregel
vi.mock("server-only", () => ({}));
vi.mock("@/modules/elternbriefe/actions", () => ({ remindLetterAction: async () => undefined }));

const perms = (role: PermissionSet["role"], granted: string[] = []): PermissionSet => ({
  userId: "u",
  role,
  locked: false,
  granted: new Set(granted),
  memberOf: new Set(),
  leaderOf: new Set(),
});

describe("Heute-Widget „Offen für dich“", () => {
  it.each(ROLES)("sichtbar für die Rolle %s", (role) => {
    expect(widgetsFor(heuteWidgets, MODULES, new Map(), perms(role)).map((w) => w.id)).toContain("heute.offen");
  });
  it("Planer:in mit Rolle Personal (Funktionsgruppe Stundenplanung) sieht es", () => {
    expect(widgetsFor(heuteWidgets, MODULES, new Map(), perms("personal", ["stundenplan.substitute", "stundenplan.manage"])).map((w) => w.id)).toContain("heute.offen");
  });
});
