// Abschluss an der Konsole (INST-01/INST-05/INST-12): Startreihenfolge setzen, Schlüssel als Text, bis Block 8 eingetippt ist,
// Bootmenü-Passwort bis zu den letzten 4 Zeichen, dann
// „Neustart oder ausschalten“ → <ausgabe>/danach (start-installer.sh führt es aus). Aus main.tsx herausgelöst, damit der echte
// Ablauf mit Ersatz-Ein-/Ausgabe testbar ist (GATE-4f C-12): EOF ist nie eine Bestätigung, ohne Antwort kein `danach`.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { CLEAR_SCREEN, closableAsk, confirmRecoveryKey, InputClosedError } from "@schulos/server/recovery-key";
import { AFTER_FILE, afterChoice, checkGrubConfirmation, finalScreen, GRUB_CONFIRM_PROMPT, grubPasswordScreen, type ConfigLocation } from "./abschluss";
import type { BootOrderResult } from "./system/boot-order";
import { framed, titleBar } from "./tui/screens";
import { detectCharset, themeFor } from "./tui/theme";

export interface ConsoleIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & { columns?: number; rows?: number };
}

export interface FinishDeps {
  /** Startreihenfolge setzen (UEFI) – läuft vor der Bestätigung */
  bootOrder: () => BootOrderResult;
  /** ohne Eingabe: nie weiter, nie von selbst neu starten (Vorgabe: ewig warten) */
  hang?: () => Promise<never>;
  /** Hinweise ohne Terminal (Vorgabe: stdout) */
  log?: (text: string) => void;
  /** INST-06: wo SCHULOSCFG liegt – ein eigener Stick soll vor dem Neustart abgezogen werden */
  configLocation?: ConfigLocation;
  /** INST-06: vor dem Hinweis „Stick jetzt abziehen“ den Stick aushängen */
  releaseStick?: () => void;
  /** INST-07: CI-Testmodus – Abschluss trägt „TESTINSTALLATION“ */
  testMode?: boolean;
  /** G4E-O04/O05: Bootmenü-Passwort für den Abschluss-Bildschirm */
  grubPassword?: string | null;
}

const forever = () => new Promise<never>(() => setInterval(() => {}, 60_000));

/** Gibt die Entscheidung zurück; ohne Terminal bzw. bei geschlossener Eingabe kehrt die Funktion nie zurück (`hang`). */
export async function finishAtConsole(
  recoveryKey: string | null,
  pairingCode: string | null,
  outDir: string,
  version: string,
  io: ConsoleIo | null,
  deps: FinishDeps,
): Promise<"neustart" | "aus"> {
  const hang = deps.hang ?? forever;
  if (!io) {
    // unbeaufsichtigt ohne Terminal: nie bestätigen, nie von selbst neu starten (EOF ≠ Bestätigung)
    (deps.log ?? ((t) => process.stdout.write(t)))("\nKein Terminal für die Bestätigung des Wiederherstellungsschlüssels – es wird nicht neu gestartet.\n");
    return hang();
  }
  const out = io.output;
  const rl = createInterface({ input: io.input, output: out });
  const theme = themeFor(detectCharset(process.env));
  const cols = out.columns || 80;
  // INST-05: Ink hat stdin beim Verlassen der Oberfläche per unref() freigegeben – closableAsk hält es wieder fest, sonst endete der
  // Prozess während der Frage mit Code 0 (Bestätigung übersprungen, Startreihenfolge nie gesetzt, nach 30 s Neustart ins Medium)
  const ask = closableAsk(rl, io.input);
  // Strg+C: ohne eigenen Handler schließt readline – hier geht es nur mit einer Antwort weiter
  rl.on("SIGINT", () => out.write("\n  Strg+C geht hier nicht – bitte die Frage beantworten.\n"));
  try {
    // Startreihenfolge zuerst (INST-05): hängt nicht mehr an der Bestätigung, ein Neustart landet so in jedem Fall auf der Platte
    out.write(`${CLEAR_SCREEN}\n  Startreihenfolge wird gesetzt …\n`);
    const boot = deps.bootOrder();
    if (recoveryKey)
      await confirmRecoveryKey(recoveryKey, {
        // Titelleiste nur, wenn sie samt Eingabezeile noch passt – der Schlüssel darf nie aus dem Bild rutschen
        show: (lines) => {
          const bar = (out.rows || 25) >= lines.length + 2 ? `${titleBar(theme, cols, "Wiederherstellungsschlüssel", version)}\n` : "";
          out.write(CLEAR_SCREEN + bar + lines.join("\n") + "\n");
        },
        ask,
      });
    // INST-12: Bootmenü-Passwort eigens bestätigen (letzte 4 Zeichen) – wie Block 8 des Schlüssels
    const grubPw = deps.grubPassword ?? null;
    if (grubPw) {
      let note = "";
      for (;;) {
        const lines = [...grubPasswordScreen(grubPw), ...(note ? [note] : []), "  (Enter ohne Eingabe zeigt das Passwort erneut an.)"];
        const bar = (out.rows || 25) >= lines.length + 2 ? `${titleBar(theme, cols, "Bootmenü-Passwort", version)}\n` : "";
        out.write(CLEAR_SCREEN + bar + lines.join("\n") + "\n");
        const r = checkGrubConfirmation(grubPw, await ask(GRUB_CONFIRM_PROMPT));
        if (r === "ok") break;
        note = r === "falsch" ? "  Das passt nicht – bitte die Abschrift prüfen (Groß-/Kleinschreibung zählt) und nochmal eintippen." : "";
      }
    }
    if (deps.configLocation === "stick") deps.releaseStick?.();
    const screen = finalScreen(boot, pairingCode, deps.configLocation ?? null, deps.testMode ?? false, deps.grubPassword ?? null);
    out.write(CLEAR_SCREEN + framed(theme, cols, "Fertig", version, screen.lines).join("\n") + "\n");
    const after = afterChoice(boot, await ask(screen.prompt));
    writeFileSync(`${outDir}/${AFTER_FILE}`, `${after}\n`);
    return after;
  } catch (e) {
    if (!(e instanceof InputClosedError)) throw e;
    // ohne lesbare Eingabe nie weiter und nie von selbst neu starten: Schlüssel bleibt stehen, der Prozess wartet
    out.write(
      "\n  Keine Eingabe möglich (Tastatur/Terminal getrennt). Schlüssel oben abschreiben, dann den Rechner ausschalten –\n" +
        "  das Startmedium erst danach entfernen. Es wird nicht automatisch neu gestartet.\n",
    );
    return hang();
  } finally {
    rl.close();
  }
}
