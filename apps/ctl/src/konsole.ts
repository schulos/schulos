// Linux-Konsole für schulosctl (INST-03): vor der Anzeige des Wiederherstellungsschlüssels UTF-8-Modus und die SchulOS-
// Konsolenschrift laden – sonst zeigt die VT „Â·“ statt Umlauten. Die Schrift legt der Installer ins System. Ohne Schrift bleibt
// die Standardschrift, der Schlüssel (nur Text, INST-05) ist trotzdem lesbar.
import { loadConsoleFont } from "../../installer/src/system/console-font";

/** Auf einer VT (TERM=linux): UTF-8 + Schrift laden; andere Terminals (SSH) bleiben unberührt */
export function prepareConsole(): void {
  if (process.env.TERM === "linux") loadConsoleFont();
}
