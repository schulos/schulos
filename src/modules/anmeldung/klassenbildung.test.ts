import { describe, expect, it } from "vitest";
import { explain, normalizeWishes, proposeClasses, sizeBounds, type KbChild, type KbInput, type KbWish } from "./klassenbildung";

/** kleiner Seed-Zufall nur für die Testdaten */
function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const SCHOOLS = ["Lindenschule", "Am Bach", "Kirchplatz", "Waldweg", "Hafen", "Dorf"];

/** zufälliger Jahrgang: Familien von 1–3 Kindern, Grundschulen ungleich groß, manche ohne Angabe */
function randomCohort(seed: number) {
  const r = rand(seed);
  const n = 8 + Math.floor(r() * 80);
  const children: KbChild[] = [];
  let fam = 0;
  while (children.length < n) {
    const famSize = r() < 0.08 ? 3 : r() < 0.15 ? 2 : 1;
    const school = r() < 0.05 ? null : SCHOOLS[Math.floor(r() * r() * SCHOOLS.length)]!;
    fam++;
    for (let j = 0; j < famSize && children.length < n; j++) {
      const id = `k${children.length}`;
      children.push({
        id,
        label: `Kind ${children.length}`,
        school,
        family: `f${fam}`,
      });
    }
  }
  const k = Math.max(1, Math.ceil(n / (24 + Math.floor(r() * 7))));
  const classNames = Array.from({ length: k }, (_, i) => `5${String.fromCharCode(97 + i)}`);
  return { children, classNames, r };
}

const classSizes = (assignment: Record<string, string>, classNames: readonly string[]) =>
  classNames.map((c) => Object.values(assignment).filter((x) => x === c).length);

describe("Klassenbildung (KB-01) – Eigenschaften", () => {
  it("Größen unterscheiden sich höchstens um 1, Familien bleiben zusammen, jedes Kind hat eine Klasse (200 Zufallsjahrgänge)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { children, classNames } = randomCohort(seed);
      const res = proposeClasses({ children, classNames, seed: seed % 3 });
      expect(Object.keys(res.assignment).sort()).toEqual(children.map((c) => c.id).sort());
      for (const v of Object.values(res.assignment)) expect(classNames).toContain(v);
      const sizes = classSizes(res.assignment, classNames);
      const { min, max } = sizeBounds(children.length, classNames.length);
      // Familien von bis zu 3 Kindern können die Verteilung nur dann sprengen, wenn es rechnerisch nicht anders geht – hier nie
      expect(Math.max(...sizes) - Math.min(...sizes), `Seed ${seed}: ${sizes.join("/")}`).toBeLessThanOrEqual(1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(max);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(min);
      for (const c of children) for (const o of children) if (c.family === o.family) expect(res.assignment[c.id]).toBe(res.assignment[o.id]);
      expect(res.warnings).toEqual([]);
      for (const c of children) expect(res.reasons[c.id]?.length).toBeGreaterThan(0);
      expect(res.stats.reduce((s, x) => s + x.size, 0)).toBe(children.length);
    }
  });

  it("deterministisch: gleicher Seed → gleiches Ergebnis, Reihenfolge der Eingabe egal für Seed 0", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { children, classNames } = randomCohort(seed);
      expect(proposeClasses({ children, classNames, seed: 7 })).toEqual(proposeClasses({ children, classNames, seed: 7 }));
      const a = proposeClasses({ children, classNames });
      const b = proposeClasses({
        children: [...children].reverse(),
        classNames,
      });
      expect(b.assignment).toEqual(a.assignment);
    }
  });

  it("„Neu vorschlagen“ (anderer Seed) ändert etwas, hält aber die harten Regeln", () => {
    const { children, classNames } = randomCohort(4242);
    expect(classNames.length).toBeGreaterThan(1);
    const variants = new Set([1, 2, 3, 4, 5].map((seed) => JSON.stringify(proposeClasses({ children, classNames, seed }).assignment)));
    expect(variants.size).toBeGreaterThan(1);
  });

  it("festgepinnte Kinder bleiben stehen; die übrigen gleichen die Größen aus", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { children, classNames, r } = randomCohort(seed);
      const pinned: Record<string, string> = {};
      for (const c of children) if (r() < 0.15) pinned[c.id] = classNames[Math.floor(r() * classNames.length)]!;
      const res = proposeClasses({ children, classNames, pinned, seed });
      for (const [id, cls] of Object.entries(pinned)) expect(res.assignment[id]).toBe(cls);
      // Familien halten zusammen, außer Pins trennen sie
      for (const c of children)
        for (const o of children)
          if (c.family === o.family && !(pinned[c.id] && pinned[o.id] && pinned[c.id] !== pinned[o.id]))
            expect(res.assignment[c.id]).toBe(res.assignment[o.id]);
    }
  });

  it("Pins, die die Größenregel sprengen, gewinnen – mit Hinweis", () => {
    const children = Array.from({ length: 6 }, (_, i) => ({
      id: `k${i}`,
      label: `K${i}`,
      school: null,
      family: `f${i}`,
    }));
    const pinned = { k0: "5a", k1: "5a", k2: "5a", k3: "5a", k4: "5a" };
    const res = proposeClasses({ children, classNames: ["5a", "5b"], pinned });
    expect(classSizes(res.assignment, ["5a", "5b"])).toEqual([5, 1]);
    expect(res.warnings.join(" ")).toMatch(/weichen um mehr als 1/);
    expect(res.reasons.k0).toContain("von Hand festgelegt (festgepinnt)");
    // Pins auf unbekannte Klassen werden ignoriert
    const ignored = proposeClasses({
      children,
      classNames: ["5a", "5b"],
      pinned: { k0: "9z" },
    });
    expect(classSizes(ignored.assignment, ["5a", "5b"])).toEqual([3, 3]);
  });

  it("Grundschulen: Gruppen von 2–3 zusammen, Gruppen ab 4 verteilt, niemand allein, wo vermeidbar", () => {
    const kids: KbChild[] = [];
    const add = (school: string, n: number) => {
      for (let i = 0; i < n; i++)
        kids.push({
          id: `${school}${i}`,
          label: `${school} ${i}`,
          school,
          family: `${school}${i}`,
        });
    };
    // lösbar ohne Kompromiss: je Klasse 3 aus A (9 Kinder), 2 aus E (4 Kinder), dazu eine Kleingruppe B/C, D bzw. F
    add("A", 9);
    add("B", 3);
    add("C", 2);
    add("D", 3);
    add("E", 4);
    add("F", 3);
    const classNames = ["5a", "5b", "5c"];
    for (const seed of [0, 1, 2, 3]) {
      const res = proposeClasses({ children: kids, classNames, seed });
      const per = (s: string) => classNames.map((c) => kids.filter((k) => k.school === s && res.assignment[k.id] === c).length);
      expect(per("A")).toEqual([3, 3, 3]);
      expect(per("B").filter((n) => n > 0)).toEqual([3]);
      expect(per("C").filter((n) => n > 0)).toEqual([2]);
      expect(per("D").filter((n) => n > 0)).toEqual([3]);
      expect(per("F").filter((n) => n > 0)).toEqual([3]);
      expect(per("E").sort()).toEqual([0, 2, 2]);
      for (const st of res.stats) expect(st.alone).toBe(0);
      expect(classSizes(res.assignment, classNames).sort()).toEqual([8, 8, 8]);
    }
  });

  it("Wünsche: „zusammen“ und „nicht zusammen“ werden erfüllt, wo möglich; Begründung nennt sie", () => {
    const kids: KbChild[] = Array.from({ length: 20 }, (_, i) => ({
      id: `k${i}`,
      label: `Kind ${i}`,
      school: i % 2 ? "A" : "B",
      family: `f${i}`,
    }));
    const wishes: KbWish[] = [
      { from: "k0", to: "k1", kind: "zusammen" },
      { from: "k1", to: "k0", kind: "zusammen" },
      { from: "k2", to: "k3", kind: "nicht_zusammen" },
      { from: "k4", to: "k7", kind: "zusammen" },
    ];
    for (const seed of [0, 1, 2]) {
      const res = proposeClasses({
        children: kids,
        classNames: ["5a", "5b"],
        wishes,
        seed,
      });
      expect(res.assignment.k0).toBe(res.assignment.k1);
      expect(res.assignment.k2).not.toBe(res.assignment.k3);
      expect(res.assignment.k4).toBe(res.assignment.k7);
      expect(res.reasons.k0).toContain("Wunsch „zusammen“ mit Kind 1 (gegenseitig): erfüllt");
      expect(res.reasons.k2).toContain("Wunsch „nicht zusammen“ mit Kind 3: erfüllt");
      expect(res.stats.reduce((s, x) => s + x.wishesMet, 0)).toBe(4);
      expect(res.stats.reduce((s, x) => s + x.wishesTotal, 0)).toBe(4);
    }
  });

  it("höchstens 2 Wünsche je Kind, Unsinn wird verworfen", () => {
    const kids = ["a", "b", "c", "d"].map((id) => ({
      id,
      label: id,
      school: null,
      family: id,
    }));
    const { wishes, dropped } = normalizeWishes(kids, [
      { from: "a", to: "b", kind: "zusammen" },
      { from: "a", to: "b", kind: "zusammen" },
      { from: "a", to: "a", kind: "zusammen" },
      { from: "a", to: "x", kind: "zusammen" },
      { from: "a", to: "c", kind: "nicht_zusammen" },
      { from: "a", to: "d", kind: "zusammen" },
    ]);
    expect(wishes).toHaveLength(2);
    expect(dropped).toBe(1);
    const res = proposeClasses({
      children: kids,
      classNames: ["5a", "5b"],
      wishes: [...wishes, { from: "a", to: "d", kind: "zusammen" }],
    });
    expect(res.warnings.join(" ")).toMatch(/1 Wunsch über der Grenze von 2/);
  });

  it("Familie „getrennt“: Geschwister auf verschiedene Klassen, sonst zusammen", () => {
    const kids: KbChild[] = [
      { id: "z1", label: "Zwilling 1", school: "A", family: "zw" },
      { id: "z2", label: "Zwilling 2", school: "A", family: "zw" },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `k${i}`,
        label: `K${i}`,
        school: "A",
        family: `f${i}`,
      })),
    ];
    const together = proposeClasses({
      children: kids,
      classNames: ["5a", "5b"],
    });
    expect(together.assignment.z1).toBe(together.assignment.z2);
    expect(together.reasons.z1).toContain("Familie zusammen (mit Zwilling 2)");
    const apart = proposeClasses({
      children: kids,
      classNames: ["5a", "5b"],
      separateFamilies: ["zw"],
    });
    expect(apart.assignment.z1).not.toBe(apart.assignment.z2);
    expect(apart.reasons.z1).toContain("Familie als „getrennt“ markiert: Geschwister in anderer Klasse");
    expect(apart.warnings).toEqual([]);
  });

  it("Randfälle: keine Klassen, keine Kinder, eine Klasse", () => {
    const kids = [{ id: "a", label: "A", school: "X", family: "a" }];
    expect(proposeClasses({ children: kids, classNames: [] }).assignment).toEqual({});
    expect(proposeClasses({ children: [], classNames: ["5a"] }).assignment).toEqual({});
    const one = proposeClasses({ children: kids, classNames: ["5a"] });
    expect(one.assignment).toEqual({ a: "5a" });
    expect(one.reasons.a).toEqual(["einziges Kind aus „X“ im Jahrgang"]);
  });

  it("explain: Kennzahlen für eine von Hand geänderte Zuordnung, „nicht übernehmen“ zählt nicht", () => {
    const input: KbInput = {
      children: [
        { id: "a", label: "A", school: "S", family: "a" },
        { id: "b", label: "B", school: "S", family: "b" },
        { id: "c", label: "C", school: "T", family: "c" },
      ],
      classNames: ["5a", "5b"],
    };
    const ex = explain(input, { a: "5a", b: "5b", c: "nicht" });
    expect(ex.stats.map((s) => s.size)).toEqual([1, 1]);
    expect(ex.stats[0]).toMatchObject({
      schools: [{ school: "S", count: 1 }],
      alone: 1,
    });
    expect(ex.reasons.c).toBeUndefined();
    expect(ex.reasons.a).toEqual(["einziges Kind aus „S“ in dieser Klasse"]);
  });
});
