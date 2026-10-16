/** Kleiner deterministischer Zufallsgenerator (mulberry32) – gleicher Seed, gleiche Schule. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  };
}

/** „Lea Schäfer" → „lea.schaefer" */
export function toUsername(first: string, last: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", ş: "s", ć: "c", č: "c", é: "e" };
  return `${first}.${last}`
    .toLowerCase()
    .replace(/[äöüßşćčé]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9.]+/g, "");
}
