// LUKS-Wiederherstellungsschlüssel anzeigen und bestätigen (INST-01): vom Installer am Ende der Installation und von
// `schulosctl wiederherstellungsschluessel` im installierten System. Nur auf den Bildschirm – nie ins Protokoll, nie seriell.
// Rein; `confirmRecoveryKey` bekommt Ein-/Ausgabe als Parameter (testbar). Kein QR-Code mehr (INST-05, Entscheidung Projektleitung): auf
// der Linux-Konsole fehlten der Schrift die Halbblöcke (◆ statt ▀ ▄), der Code war nicht lesbar – der Schlüssel steht als Text da.

/** systemd-cryptenroll gibt den Schlüssel in „modhex“ aus: 8 Gruppen à 8 Zeichen */
export function extractRecoveryKey(text: string): string | null {
  return /\b([cbdefghijklnrtuv]{8}(?:-[cbdefghijklnrtuv]{8}){7})\b/.exec(text)?.[1] ?? null;
}

export function keyBlocks(key: string): string[] {
  return key.split("-");
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "");

/**
 * Bestätigung: der letzte Block (oder der ganze Schlüssel). Leere Eingabe = Schlüssel erneut anzeigen.
 * Groß-/Kleinschreibung, Leerzeichen und Bindestriche zählen nicht.
 */
export function checkConfirmation(key: string, input: string): "ok" | "anzeigen" | "falsch" {
  const n = normalize(input);
  if (!n) return "anzeigen";
  const blocks = keyBlocks(key);
  return n === normalize(blocks.at(-1)!) || n === normalize(key) ? "ok" : "falsch";
}

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Bildschirm mit Schlüssel: Blöcke nummeriert in zwei Spalten, darunter der ganze Schlüssel – passt in 80×25. */
export function recoveryKeyScreen(key: string): string[] {
  const b = keyBlocks(key);
  return [
    "",
    `  ${BOLD}WIEDERHERSTELLUNGSSCHLÜSSEL${RESET}`,
    "",
    "  Bitte abschreiben (oder abfotografieren) und sicher verwahren.",
    "  Ohne ihn sind die Daten weg, wenn das TPM ausfällt",
    "  (Mainboard-Tausch, manche Firmware-Updates).",
    "",
    ...[0, 2, 4, 6].map((i) => `      ${i + 1}   ${BOLD}${b[i]}${RESET}        ${i + 2}   ${BOLD}${b[i + 1]}${RESET}`),
    "",
    "  Eingabe beim Start: alle 8 Blöcke mit Bindestrichen, so wie hier:",
    "",
    `  ${BOLD}${key}${RESET}`,
    "",
  ];
}

export const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

export interface ConfirmIo {
  /** ganzen Bildschirm neu zeichnen */
  show(lines: string[]): void;
  ask(prompt: string): Promise<string>;
}

/** INST-09: als Aufforderung formuliert – „Zur Bestätigung Block 8 eintippen“ wurde nicht als Frage erkannt (Befund 0.5.0) */
export const CONFIRM_PROMPT = "  Tippe Block 8 des Wiederherstellungsschlüssels ein: ";
const CONFIRM_HINT = "  (Enter ohne Eingabe zeigt den Schlüssel erneut an.)";

/** Schlüssel zeigen, bis der letzte Block richtig eingetippt ist – ohne Zeitlimit. */
export async function confirmRecoveryKey(key: string, io: ConfirmIo): Promise<void> {
  let note = "";
  for (;;) {
    io.show([...recoveryKeyScreen(key), ...(note ? [note] : []), CONFIRM_HINT]);
    const answer = await io.ask(CONFIRM_PROMPT);
    const r = checkConfirmation(key, answer);
    if (r === "ok") return;
    note = r === "falsch" ? "  Das war nicht Block 8 – bitte die Abschrift prüfen und nochmal eintippen." : "";
  }
}

/** Eingabe beendet (EOF, Terminal weg), bevor eine Antwort kam – gilt nie als Bestätigung (INST-05) */
export class InputClosedError extends Error {
  constructor() {
    super("Eingabe geschlossen – keine Bestätigung möglich");
    this.name = "InputClosedError";
  }
}

/** das, was `ask` von readline/promises braucht */
export interface QuestionInterface {
  question(prompt: string): Promise<string>;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

/**
 * Fragen über readline, die bei geschlossener Eingabe mit `InputClosedError` scheitern statt ewig offen zu bleiben (INST-05).
 * Hält `input` aktiv (`ref`): Ink setzt beim Verlassen der Oberfläche `stdin.unref()` – danach hielt die offene Frage den Prozess
 * nicht mehr, Node beendete ihn mit Code 0 ohne Eingabe, und start-installer.sh startete nach 30 s neu, ohne Bestätigung und
 * ohne Startreihenfolge (Hyper-V-Befund 0.3.2: „Fertig. Startmedium entfernen …“, danach wieder der Installer).
 */
export function closableAsk(rl: QuestionInterface, input: object): (prompt: string) => Promise<string> {
  (input as { ref?: () => unknown }).ref?.();
  let closed = false;
  rl.once("close", () => (closed = true));
  return (prompt) =>
    closed
      ? Promise.reject(new InputClosedError())
      : new Promise<string>((resolve, reject) => {
          const onClose = () => reject(new InputClosedError());
          rl.once("close", onClose);
          rl.question(prompt).then(
            (a) => {
              rl.off("close", onClose);
              resolve(a);
            },
            (e: unknown) => {
              rl.off("close", onClose);
              reject(e instanceof Error && e.name === "AbortError" ? new InputClosedError() : e);
            },
          );
        });
}
