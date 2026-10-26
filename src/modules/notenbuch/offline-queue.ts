// Notenbuch (P5-20, Review R3 N1/N2): Warteschlange der Offline-Eingabe im Browser – rein, ohne IndexedDB (die Ablage kommt als
// Funktion herein, im Test ein Speicher-Objekt). Zwei Regeln gegen stillen Notenverlust:
//   · **N1 – ein Schreibvorgang nach dem anderen.** Jede Änderung ist eine Funktion „aktueller Stand → neuer Stand“, die erst
//     ausgeführt wird, wenn der vorige Schreibvorgang fertig ist. Scheitert das Speichern einer neuen Eingabe, gilt sie nicht –
//     nur sie fällt heraus, parallel eingetragene Zellen und Abgleich-Ergebnisse bleiben (früher: Rücksprung auf eine
//     Momentaufnahme von vor dem Schreiben, die dazwischen gespeicherte Eingaben überschrieb).
//   · **N2 – nie über eine unlesbare Warteschlange schreiben.** Ließ sich die gespeicherte Warteschlange nicht lesen, nimmt das
//     Buch keine Offline-Eingaben mehr an und schreibt nichts – sonst ersetzte die nächste Eingabe die gespeicherten (noch nicht
//     übertragenen) Noten durch eine Warteschlange mit nur dieser einen Eingabe.
import type { OfflineOp } from "./offline-sync";

export interface QueueUpdate {
  /** Speichern gescheitert? Dann trotzdem übernehmen (Abgleich: der Server hat schon angewendet) statt verwerfen (neue Eingabe). */
  keepOnFailure?: boolean;
}

export interface QueueUpdateResult {
  /** in der Ablage gespeichert */
  saved: boolean;
  /** im Arbeitsspeicher übernommen */
  applied: boolean;
}

export class OfflineQueue {
  private ops: readonly OfflineOp[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private open = 0;
  private unreadableFlag = false;
  /** steigt bei load/markUnreadable/reset – ein Schreibvorgang von davor füllt den neuen Stand nicht wieder auf */
  private generation = 0;

  constructor(
    /** verschlüsselt speichern (leer = löschen); wirft bei Fehler */
    private write: (ops: readonly OfflineOp[]) => Promise<void>,
    /** neuer Stand im Arbeitsspeicher (Anzeige „ausstehend“) */
    private readonly onChange: (ops: readonly OfflineOp[]) => void = () => undefined,
  ) {}

  /** Ablage tauschen (React: nach dem Rendern, sobald Konto/Buch feststehen) – gilt für alle noch nicht begonnenen Schreibvorgänge */
  setWriter(write: (ops: readonly OfflineOp[]) => Promise<void>): void {
    this.write = write;
  }

  /** aktueller (gespeicherter bzw. vom Server bestätigter) Stand – Methode statt `current`, sonst hält React ihn für einen Ref */
  snapshot(): readonly OfflineOp[] {
    return this.ops;
  }

  /** laufende oder wartende Schreibvorgänge – solange > 0, warnt die Seite beim Verlassen */
  get pendingWrites(): number {
    return this.open;
  }

  /** gespeicherte Warteschlange nicht lesbar – keine Offline-Eingaben, kein Schreiben */
  get unreadable(): boolean {
    return this.unreadableFlag;
  }

  /** gelesenen Stand übernehmen (Start, Einschalten) – ohne zu schreiben */
  load(ops: readonly OfflineOp[]): void {
    this.generation++;
    this.unreadableFlag = false;
    this.ops = ops;
    this.onChange(ops);
  }

  /** Lesen gescheitert (N2): gesperrt bis zum nächsten erfolgreichen `load` */
  markUnreadable(): void {
    this.generation++;
    this.unreadableFlag = true;
    this.ops = [];
    this.onChange(this.ops);
  }

  /** Arbeitsspeicher leeren (Ausschalten, Zwischenspeicher gelöscht) – die Ablage räumt der Aufrufer */
  reset(): void {
    this.generation++;
    this.unreadableFlag = false;
    this.ops = [];
    this.onChange(this.ops);
  }

  /** wartet, bis alle angestoßenen Schreibvorgänge durch sind */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /**
   * Änderung einreihen: `fn` sieht den Stand **nach** allen vorher eingereihten Änderungen. Neuer Stand wird erst gespeichert,
   * dann übernommen; scheitert das Speichern, bleibt der alte Stand (außer `keepOnFailure`).
   */
  update(fn: (current: readonly OfflineOp[]) => readonly OfflineOp[], opts: QueueUpdate = {}): Promise<QueueUpdateResult> {
    this.open++;
    const run = this.tail.then(async (): Promise<QueueUpdateResult> => {
      try {
        if (this.unreadableFlag) return { saved: false, applied: false };
        const gen = this.generation;
        const next = fn(this.ops);
        let saved = true;
        try {
          await this.write(next);
        } catch {
          saved = false;
        }
        if (!saved && !opts.keepOnFailure) return { saved, applied: false };
        // während des Schreibens neu geladen, gesperrt oder geleert (z. B. ausgeschaltet): nicht wieder auffüllen
        if (gen !== this.generation) return { saved, applied: false };
        this.ops = next;
        this.onChange(next);
        return { saved, applied: true };
      } finally {
        this.open--;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * Gespeicherte Warteschlange lesen, bei einem Fehler einmal erneut (kurzer Hänger der IndexedDB). `ok: false` heißt: **nicht**
 * leer, sondern unbekannt – dann nichts schreiben (N2).
 */
export async function readQueueSafely(read: () => Promise<OfflineOp[]>, attempts = 2): Promise<{ ok: true; ops: OfflineOp[] } | { ok: false }> {
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, ops: await read() };
    } catch {
      // nächster Versuch
    }
  }
  return { ok: false };
}
