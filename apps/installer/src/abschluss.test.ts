import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { afterChoice, configLocation, endingFor, finalScreen, RESPONSIBILITY_NOTE, summaryText } from "./abschluss";
import type { BootOrderResult } from "./system/boot-order";

const KEY = "fvhkbbdg-nnctbgrl-jtrgtvif-ceubtfcb-dlgbvdec-ckdhbgnh-hcteduvg-knnvcrtj";
const SCRIPT = path.resolve(__dirname, "../../../iso/live/config/includes.chroot/usr/local/lib/schulos/start-installer.sh");

describe("Abschluss der Installation (INST-01)", () => {
  it("Startreihenfolge gesetzt: Neustart als Vorgabe, Medium erst nach dem Neustart, eigener Stick JETZT (INST-06)", () => {
    const boot: BootOrderResult = { ok: true, order: ["0003", "0001"] };
    const s = finalScreen(boot, "ABCD-EFGH");
    const text = s.lines.join("\n");
    expect(text).toContain("ABCD-EFGH");
    // INST-05: wo es weitere Codes gibt
    expect(text).toContain("„Instanzen“ → „Kopplungscode erzeugen“");
    // INST-01: nie das Medium im laufenden Live-System entfernen lassen
    expect(text).toContain("Das Installationsmedium kann nach dem Neustart entfernt werden – bleibt es drin, startet SchulOS");
    expect(text).toContain("automatisch von der Festplatte");
    expect(text).not.toMatch(/Installationsmedium[^.\n]*JETZT|JETZT[^.\n]*Installationsmedium/);
    expect(text).not.toContain("SCHULOSCFG");
    // eigener Stick: ausdrücklich JETZT abziehen, direkt vor der Frage
    const stick = finalScreen(boot, null, "stick");
    expect(stick.lines.join("\n")).toContain(">>> Konfigurations-Stick (SCHULOSCFG) JETZT abziehen, dann die Taste drücken. <<<");
    expect(stick.lines.slice(-6).join("\n")).toContain("JETZT abziehen");
    // SCHULOSCFG auf dem Live-Medium selbst: wie das Medium – erst nach dem Neustart, kein „startet automatisch“
    const medium = finalScreen(boot, null, "medium").lines.join("\n");
    expect(medium).toContain("liegt auf dem Installationsmedium");
    expect(medium).not.toContain("JETZT");
    expect(medium).not.toContain("startet SchulOS");
    expect(configLocation({ SCHULOS_CFG_ORT: "stick" })).toBe("stick");
    expect(configLocation({ SCHULOS_CFG_ORT: "medium" })).toBe("medium");
    expect(configLocation({})).toBeNull();
    expect(s.prompt).toContain("Enter = Neustart");
    expect(afterChoice(boot, "")).toBe("neustart");
    expect(afterChoice(boot, "a")).toBe("aus");
    expect(afterChoice(boot, " A ")).toBe("aus");
  });

  it("Startreihenfolge nicht gesetzt: Boot-Menü-Hinweis, ausschalten als Vorgabe, Stick JETZT, Medium danach", () => {
    const boot: BootOrderResult = { ok: false, reason: "kein UEFI" };
    const s = finalScreen(boot, null, "stick");
    const text = s.lines.join("\n");
    expect(text).toContain("kein UEFI");
    expect(text).toContain("Boot-Menü");
    expect(text).toContain("Konfigurations-Stick (SCHULOSCFG) JETZT abziehen");
    expect(text).toContain("Installationsmedium kann nach dem Neustart entfernt werden");
    expect(text).not.toContain("Kopplungscode");
    expect(s.prompt).toContain("Enter = ausschalten");
    expect(afterChoice(boot, "")).toBe("aus");
    expect(afterChoice(boot, "n")).toBe("neustart");
  });

  it("DS-14: Verantwortungshinweis auf dem Abschluss-Bildschirm und in der unbeaufsichtigten Zusammenfassung", () => {
    expect(RESPONSIBILITY_NOTE).toMatch(/ohne Gewähr \(AGPL-3\.0, §§ 15–16\)/);
    expect(RESPONSIBILITY_NOTE).toMatch(/Verantwortliche nach DSGVO ist die Schule/);
    expect(RESPONSIBILITY_NOTE).toMatch(/Datenschutzbeauftragten/);
    const boots: BootOrderResult[] = [{ ok: true, order: ["0001"] }, { ok: false, reason: "x" }];
    for (const boot of boots) expect(finalScreen(boot, null).lines.join("\n")).toContain(RESPONSIBILITY_NOTE);
    expect(summaryText(null, null)).toContain(RESPONSIBILITY_NOTE);
  });

  it("start-installer.sh führt die Entscheidung aus, danach-aus hat Vorrang, kein alter Stand", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh).toContain('rm -f "$AFTER"');
    const ok = sh.slice(sh.indexOf("if [ $rc -eq 0 ]"));
    expect(ok.indexOf("flag danach-aus")).toBeLessThan(ok.indexOf('case "$(cat "$AFTER"'));
    // normaler Neustart wie in INST-05 (kein erzwungener Neustart, kein SysRq)
    expect(ok).toContain("aus) exec systemctl poweroff ;;");
    expect(ok).toContain("neustart) exec systemctl reboot ;;");
    expect(sh).not.toMatch(/sysrq|--force/);
    // INST-05: von selbst neu starten nur ohne Oberfläche; interaktiv nie per Zeitablauf, nie „Startmedium entfernen“ vor dem Ausschalten
    const fallback = ok.slice(ok.indexOf('case "$(cat "$AFTER"'), ok.indexOf("elif [ $rc -eq 5 ]"));
    const auto = fallback.slice(0, fallback.indexOf("  else\n"));
    expect(auto).toContain('*" --ohne-bestaetigung "*');
    expect(auto).not.toContain("--unbeaufsichtigt");
    // Test-Schalter nur zusammen mit unbeaufsichtigt
    expect(sh).toContain('  [[ " ${ARGS[*]} " == *" --unbeaufsichtigt "* ]] && flag ohne-bestaetigung && ARGS+=(--ohne-bestaetigung)');
    expect(auto).toContain("sleep 30 && exec systemctl reboot");
    const interactive = fallback.slice(fallback.indexOf("  else\n"));
    expect(interactive).not.toMatch(/sleep 30(?!\d)|timeout|read -r -t/);
    expect(fallback).not.toContain("Startmedium entfernen");
  });

  // Schwärzung für die serielle Schnittstelle (unbeaufsichtigt): das awk-Programm aus start-installer.sh auf die Ausgabe
  const awk = spawnSync("awk", ["BEGIN { exit 0 }"]).status === 0;
  it.skipIf(!awk)("unbeaufsichtigt: Schlüssel und Kopplungscode bleiben seriell geschwärzt", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    const prog = /awk '(\{[\s\S]*?\})'\n/.exec(sh)?.[1];
    expect(prog).toBeTruthy();
    // G4E-O04/O05: auch das Bootmenü-Passwort
    const out = summaryText(KEY, "K7Q2-ABCD-9XYZ", false, "abcdefgh23456789");
    expect(out).toContain("abcd efgh 2345 6789");
    const r = spawnSync("awk", [prog!], { input: out, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WIEDERHERSTELLUNGSSCHLÜSSEL");
    expect(r.stdout).not.toContain(KEY);
    expect(r.stdout).not.toContain("K7Q2-ABCD-9XYZ");
    expect(r.stdout).toContain("(nur auf dem Bildschirm)");
    expect(r.stdout).toContain("Bootmenü-Passwort (GRUB, Benutzer schulos): (nur auf dem Bildschirm)");
    expect(r.stdout).not.toMatch(/abcd|2345/);
    // Abschluss-Bildschirm zeigt es (nur dort bzw. auf tty1)
    expect(finalScreen({ ok: true, order: [] }, null, null, false, "abcdefgh23456789").lines.join("\n")).toContain(
      "Bootmenü-Passwort (GRUB, Benutzer schulos): abcd efgh 2345 6789",
    );
  });
});

describe("Ende der Installation (INST-05)", () => {
  it("auch unbeaufsichtigt mit Bestätigung auf der Konsole; ohne Bestätigung nur mit dem Test-Schalter", () => {
    expect(endingFor({ interactiveTty: true, unattended: false, skipConfirmation: false })).toBe("bildschirm");
    expect(endingFor({ interactiveTty: false, unattended: true, skipConfirmation: false })).toBe("konsole");
    expect(endingFor({ interactiveTty: false, unattended: true, skipConfirmation: true })).toBe("zeilen");
    // --plan im Container-Test (kein Terminal, nicht unbeaufsichtigt): Zeilen wie bisher
    expect(endingFor({ interactiveTty: false, unattended: false, skipConfirmation: false })).toBe("zeilen");
  });
});
