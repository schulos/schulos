import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { CTX, PRODUCTION } from "../fixtures";
import { UiProvider } from "./App";
import { InstallView } from "./Install";
import { cleanLogLine, ProgressStore, tailLog } from "./progress";
import { framed, titleBar, wrapLine } from "./screens";
import { sections } from "./sections";
import { themeFor, type Charset } from "./theme";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOG = "/run/schulos-installer/installation.log";

function show(store: ProgressStore, charset: Charset = "unicode", rows = 25, columns = 80) {
  return render(
    <UiProvider charset={charset} size={{ columns, rows }} version="0.2.1">
      <InstallView
        store={store}
        log={LOG}
        readLog={(n) => ["$ debootstrap --variant=minbase trixie /target file:///run/live/medium/debian", "I: Retrieving InRelease", "I: Validating Packages"].slice(-n)}
        steps={sections(PRODUCTION, CTX, "install")}
        now={() => 1_000_000 + 754_000}
        interval={10}
      />
    </UiProvider>,
  );
}

let app: ReturnType<typeof render> | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
});

describe("Installationsphase", () => {
  it("Fortschritt: Schritt x/y, Balken, Prozent, Titel, Zeit, Protokoll dezent – in 80×25", async () => {
    const store = new ProgressStore(1_000_000);
    app = show(store);
    store.set({ index: 36, total: 112, title: "Grundsystem (debootstrap)" });
    await tick();
    const f = app.lastFrame()!;
    expect(f).toContain("Installation läuft");
    expect(f).toContain("Schritt 37 von 112");
    expect(f).toContain("32 %");
    expect(f).toContain("▶ Grundsystem (debootstrap)");
    expect(f).toContain("12:34");
    expect(f).toMatch(/█+░+/);
    expect(f).toContain("I: Validating Packages");
    expect(f).toContain("▶ Installation");
    expect(f).toContain("✔ Zusammenfassung");
    const lines = f.split("\n");
    expect(lines).toHaveLength(25);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
  });

  it("Fehler: klarer Abbruch mit Protokoll und Alt+F2, drei Zeilen frei für start-installer.sh", async () => {
    const store = new ProgressStore(1_000_000);
    app = show(store, "konsole");
    store.set({ index: 4, total: 112, title: "Platte verschlüsseln" });
    store.set({ error: { message: "Platte verschlüsseln: Device /dev/sda2 is in use" } });
    await tick();
    const f = app.lastFrame()!;
    expect(f).toContain("x Installation abgebrochen");
    expect(f).toContain("Schritt 5 von 112: Platte verschlüsseln");
    expect(f).toContain("Device /dev/sda2 is in use");
    expect(f).toContain(LOG);
    expect(f).toContain("Alt+F2");
    expect(f.split("\n")).toHaveLength(22);
    expect(f).toMatch(/^┌/);
  });

  it("Protokoll lesen: nur das Ende, ohne Zeitstempel und Steuerzeichen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "protokoll-"));
    try {
      const file = path.join(dir, "installation.log");
      expect(tailLog(file, 3)).toEqual([]);
      const lines = Array.from({ length: 500 }, (_, i) => `2026-10-10T20:00:00.000Z Zeile ${i}`);
      writeFileSync(file, lines.join("\n") + "\n2026-10-10T20:00:01.000Z \x1b[32mfertig\x1b[0m\r\n\n");
      expect(tailLog(file, 3, 256)).toEqual(["Zeile 498", "Zeile 499", "fertig"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(cleanLogLine("2026-10-10T20:00:00.123Z $ mkfs.btrfs -L schulos /dev/mapper/root")).toBe("$ mkfs.btrfs -L schulos /dev/mapper/root");
  });
});

describe("Abschlussbildschirme (INST-01) eingebettet", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("Titelleiste: genau eine Zeile in Bildschirmbreite", () => {
    const t = titleBar(themeFor("konsole"), 80, "Wiederherstellungsschlüssel", "0.2.1");
    expect(t.split("\n")).toHaveLength(1);
    expect([...strip(t)]).toHaveLength(80);
    expect(strip(t)).toMatch(/^ SchulOS-Installer · Wiederherstellungsschlüssel +Version 0\.2\.1 $/);
    expect(titleBar(themeFor("ascii"), 60, "x", "dev", true)).not.toContain("\x1b");
  });

  it("Rahmen mit Logo um den Abschluss: Inhalt unverändert, lange Zeilen umbrochen, nichts breiter als der Bildschirm", () => {
    const lines = ["", "  Installation abgeschlossen.", "", "  Kopplungscode für das Hauptsystem (24 h gültig): K7Q2-9MXA-4RT1", "", `  ${"Wort ".repeat(30).trim()}`];
    const out = framed(themeFor("konsole"), 80, "Fertig", "0.2.1", lines).map(strip);
    expect(out[0]).toMatch(/^┌─+┐$/);
    expect(out.at(-1)).toMatch(/^└─+┘$/);
    expect(out[1]).toContain("█▀▀ ▄▄▄ █▄▄");
    expect(out.join("\n")).toContain("Kopplungscode für das Hauptsystem (24 h gültig): K7Q2-9MXA-4RT1");
    for (const l of out) expect([...l]).toHaveLength(80);
    expect(out.filter((l) => l.includes("Wort")).length).toBeGreaterThan(1);
    expect(framed(themeFor("ascii"), 80, "Fertig", "dev", ["x"], false)[0]).toMatch(/^\+-+\+$/);
  });

  it("Umbruch an Leerzeichen mit Einrückung", () => {
    expect(wrapLine("  eins zwei drei vier", 12)).toEqual(["  eins zwei", "  drei vier"]);
    expect(wrapLine("kurz", 12)).toEqual(["kurz"]);
  });
});
