// Fortschritt der Systemschritte für die Text-Oberfläche (INST-02): main.tsx meldet Schritte und Fehler, InstallView zeigt sie.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface ProgressState {
  /** 0-basiert; -1 = noch kein Schritt */
  index: number;
  total: number;
  title: string;
  startedAt: number;
  error: { message: string } | null;
}

export class ProgressStore {
  state: ProgressState;
  private listeners = new Set<() => void>();
  constructor(startedAt = Date.now()) {
    this.state = { index: -1, total: 0, title: "", startedAt, error: null };
  }
  set(p: Partial<ProgressState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  get = () => this.state;
}

// Zeitstempel und Steuerzeichen weg (das Protokoll enthält Befehlsausgaben – Fortschrittsbalken, Farben)
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
export function cleanLogLine(line: string): string {
  return line
    .replace(TIMESTAMP, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trimEnd();
}

/** Die letzten `n` nicht leeren Zeilen des Protokolls (liest nur das Ende der Datei); [] wenn es (noch) fehlt */
export function tailLog(file: string, n: number, bytes = 8192): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift(); // angeschnittene erste Zeile
    return lines.map(cleanLogLine).filter(Boolean).slice(-n);
  } finally {
    closeSync(fd);
  }
}
