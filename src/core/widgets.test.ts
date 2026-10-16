import { describe, expect, it } from "vitest";
import type { PermissionSet } from "@/core/permissions";
import { defineModule } from "@/core/modules/types";
import { widgetsFor, type WidgetDef } from "./widgets";

const mod = (id: string, extra = {}) => defineModule({ id, name: id, description: "", icon: "Box", section: "unterricht", ...extra });
const C = async () => null;
const defs: WidgetDef[] = [
  { id: "a.later", moduleId: "a", order: 50, Component: C },
  { id: "a.first", moduleId: "a", order: 1, Component: C },
  { id: "a.lk", moduleId: "a", roles: ["lehrkraft"], Component: C },
  { id: "a.perm", moduleId: "a", requires: "a.secret", Component: C },
  { id: "b.x", moduleId: "b", Component: C },
  { id: "ghost.x", moduleId: "ghost", Component: C },
];
const schueler: PermissionSet = { userId: "s", role: "schueler", locked: false, granted: new Set(), memberOf: new Set(), leaderOf: new Set() };

describe("widgetsFor", () => {
  it("sortiert, filtert nach Rolle/Recht, ignoriert unbekannte Module", () => {
    expect(widgetsFor(defs, [mod("a"), mod("b")], new Map(), schueler).map((w) => w.id)).toEqual(["a.first", "a.later", "b.x"]);
  });
  it("zeigt Rollen- und Rechte-Widgets, wenn passend", () => {
    const lk = { ...schueler, role: "lehrkraft" as const, granted: new Set(["a.*"]) };
    expect(widgetsFor(defs, [mod("a")], new Map(), lk).map((w) => w.id)).toEqual(["a.first", "a.later", "a.lk", "a.perm"]);
  });
  it("blendet Widgets abgeschalteter Module aus", () => {
    expect(widgetsFor(defs, [mod("a"), mod("b")], new Map([["a", false]]), schueler).map((w) => w.id)).toEqual(["b.x"]);
  });
});
