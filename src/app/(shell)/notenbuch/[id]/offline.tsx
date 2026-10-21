"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { offlineActivateAction, offlineDeactivateAction, offlineShareAction, offlineSyncAction } from "@/modules/notenbuch/actions";
import { OFFLINE_REASON_TEXT, type OfflineDecision, type OfflineReason } from "@/modules/notenbuch/offline-reasons";
import { deriveCacheKey, importDeviceShare, randomBytes, SHARE_BYTES } from "@/modules/notenbuch/offline-crypto";
import {
  mergeOp,
  reconcileQueue,
  resolveInQueue,
  transferAllQueues,
  type OfflineConflict,
  type OfflineOp,
  type QueueStore,
  type ServerCell,
} from "@/modules/notenbuch/offline-sync";
import { Button } from "@schulos/ui/button";
import { clearAll, idbAvailable, loadDevice, queuedBooks, queueStore, readQueue, saveDevice, writeQueue } from "./offline-store";

/**
 * Offline-Eingabe (P5-20) im Browser – Zustand je Notentabelle:
 *   · `aus`/`nicht-verfuegbar`: kein Cache (Einstellung, Privatgerät, kein Zertifikat, kein IndexedDB/WebCrypto)
 *   · `bereit`: hier erlaubt, auf diesem Gerät noch nicht eingeschaltet
 *   · `aktiv`: Cache-Schlüssel im Arbeitsspeicher (Geräteanteil aus IndexedDB + Server-Anteil vom Server), Warteschlange
 *     verschlüsselt in IndexedDB (eine Datenbank je Konto); ohne Verbindung landen Eingaben dort, mit Verbindung werden sie
 *     abgeglichen. Konflikte bleiben in der Warteschlange, bis die Lehrkraft sie auflöst.
 *   · `keine-verbindung`: Seite ohne Verbindung geöffnet – ohne Server-Anteil kein Schlüssel, nichts wird abgelegt
 * Der Server-Anteil wird nie gespeichert. `keep: false` (Frist, Ort, Einstellung) → Warteschlangen **aller** Bücher übertragen,
 * erst wenn nichts mehr offen ist löschen (`expiring`); `gone` → löschen, mit Hinweis, wenn noch etwas lag.
 */
export type OfflineStatus = "laedt" | "aus" | "nicht-verfuegbar" | "bereit" | "aktiv" | "keine-verbindung";

const cellKey = (columnId: string, studentId: string) => `${columnId}:${studentId}`;

/** Verbindungszustand des Browsers als externe Quelle (online/offline-Ereignisse). */
function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const books = (n: number) => `${n} ${n === 1 ? "Notenbuch" : "Notenbüchern"}`;

function expiringText(reason: OfflineReason): string {
  return reason === "privatgeraet" || reason === "kein-zertifikat" || reason === "aus"
    ? OFFLINE_REASON_TEXT[reason]
    : "Die Frist des Offline-Zwischenspeichers ist abgelaufen – bei Bedarf neu einschalten.";
}

export interface OfflineApi {
  status: OfflineStatus;
  decision: OfflineDecision;
  online: boolean;
  /** offene Offline-Änderungen je Zelle (inkl. Konflikte) */
  pending: ReadonlyMap<string, OfflineOp>;
  /** weitere Bücher mit Warteschlange auf diesem Gerät */
  otherBooks: number;
  /** Gerät nicht mehr berechtigt: nur noch übertragen und Konflikte klären, keine neuen Offline-Eingaben */
  expiring: boolean;
  conflicts: readonly OfflineConflict[];
  rejected: readonly { op: OfflineOp; reason: string }[];
  expiresAt: string | null;
  error: string | null;
  syncing: boolean;
  /** Eingabe in die Warteschlange (nur `aktiv`) – false: nicht möglich */
  enqueue: (op: Omit<OfflineOp, "opId" | "at">) => Promise<boolean>;
  sync: () => Promise<void>;
  activate: (confirmed: boolean) => Promise<void>;
  deactivate: () => Promise<void>;
  resolve: (conflict: OfflineConflict, choice: "mine" | "server") => Promise<void>;
}

export interface OfflineCallbacks {
  /** Zelle auf dem Server angewendet (neue Revision) */
  onApplied: (key: string, op: OfflineOp, version: number) => void;
  /** Server-Wert übernehmen (Konflikt: „Server-Wert behalten“) */
  onServerValue: (key: string, cell: ServerCell | null) => void;
  /** abgelehnt (gesperrt, ungültig) – Zelle zurücksetzen und melden */
  onRejected: (key: string, op: OfflineOp, reason: string) => void;
}

export function useOfflineGrades(bookId: string, userId: string, decision: OfflineDecision, locked: boolean, callbacks: OfflineCallbacks): OfflineApi {
  const [status, setStatus] = useState<OfflineStatus>("laedt");
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [pending, setPending] = useState<Map<string, OfflineOp>>(new Map());
  const [otherBooks, setOtherBooks] = useState(0);
  const [expiring, setExpiring] = useState(false);
  const [conflicts, setConflicts] = useState<OfflineConflict[]>([]);
  const [rejected, setRejected] = useState<{ op: OfflineOp; reason: string }[]>([]);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const key = useRef<{ deviceId: string; cacheKey: CryptoKey } | null>(null);
  const queue = useRef<OfflineOp[]>([]);
  const expiringRef = useRef<OfflineReason | null>(null);
  const cb = useRef(callbacks);
  useEffect(() => {
    cb.current = callbacks;
  });
  const syncRun = useRef<Promise<void> | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => undefined);

  const idle: OfflineStatus = decision.mode === "aus" ? "aus" : decision.allowed ? "bereit" : "nicht-verfuegbar";

  /** Laufende Schreibvorgänge in den Zwischenspeicher – solange > 0, warnt die Seite beim Verlassen. */
  const writes = useRef(0);

  /**
   * Warteschlange übernehmen: erst verschlüsselt speichern, dann als „ausstehend“ anzeigen. Vorher stand „ausstehend“ schon da,
   * während das Schreiben noch lief – wer die Seite in dieser Lücke verließ, verlor die Eingabe still (Release-PR #71). Liefert
   * `false`, wenn das Speichern scheiterte (dann mit Hinweis, im Arbeitsspeicher bleibt die Warteschlange bis zum Verlassen).
   */
  const setQueue = useCallback(
    async (ops: OfflineOp[]): Promise<boolean> => {
      queue.current = ops;
      let saved = true;
      if (key.current) {
        writes.current++;
        try {
          await writeQueue(userId, key.current.cacheKey, key.current.deviceId, bookId, ops);
        } catch {
          saved = false;
          setError("Die Offline-Eingabe ließ sich auf diesem Gerät nicht speichern – bitte die Seite nicht schließen und erneut eintragen.");
        } finally {
          writes.current--;
        }
      }
      setPending(new Map(ops.map((o) => [cellKey(o.columnId, o.studentId), o])));
      return saved;
    },
    [bookId, userId],
  );

  // Seite verlassen, solange noch geschrieben wird: der Browser fragt nach (sonst bricht er das Schreiben ab)
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (writes.current === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  /** Alles dieses Kontos auf diesem Gerät löschen (andere Konten bleiben, G5A-S05). */
  const wipe = useCallback(async () => {
    key.current = null;
    queue.current = [];
    expiringRef.current = null;
    setPending(new Map());
    setOtherBooks(0);
    setExpiring(false);
    setExpiresAt(null);
    await clearAll(userId);
  }, [userId]);

  const sync = useCallback(async () => {
    if (!key.current || queue.current.length === 0 || !navigator.onLine) return;
    if (syncRun.current) return syncRun.current;
    let again = false;
    const run = (async () => {
      setSyncing(true);
      try {
        // G5A-C03: Momentaufnahme senden, die Antwort mit der **aktuellen** Warteschlange zusammenführen
        const sent = queue.current;
        const res = await offlineSyncAction(bookId, key.current!.deviceId, sent);
        if (!res.ok || !res.results) {
          setError(res.error ?? "Abgleich fehlgeschlagen");
          return;
        }
        const out = reconcileQueue(queue.current, sent, res.results);
        for (const [k, a] of out.applied) cb.current.onApplied(k, a.op, a.version);
        for (const r of out.rejected) cb.current.onRejected(cellKey(r.op.columnId, r.op.studentId), r.op, r.reason);
        if (out.rejected.length) setRejected((prev) => [...prev, ...out.rejected]);
        setConflicts((prev) => {
          const cells = new Set(out.queue.map((o) => cellKey(o.columnId, o.studentId)));
          const fresh = new Set(out.conflicts.map((n) => cellKey(n.op.columnId, n.op.studentId)));
          return [...prev.filter((c) => cells.has(cellKey(c.op.columnId, c.op.studentId)) && !fresh.has(cellKey(c.op.columnId, c.op.studentId))), ...out.conflicts];
        });
        await setQueue(out.queue);
        if (!expiringRef.current) setError(null);
        const sentIds = new Set(sent.map((o) => o.opId));
        again = out.queue.some((o) => !sentIds.has(o.opId));
      } catch {
        // keine Verbindung – bleibt in der Warteschlange
      } finally {
        setSyncing(false);
        syncRun.current = null;
      }
      // während des Abgleichs eingetragen: gleich hinterher
      if (again) await syncRef.current();
    })();
    syncRun.current = run;
    return run;
  }, [bookId, setQueue]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  /**
   * G5A-C04: Gerät nicht mehr berechtigt (`keep: false`) – erst dieses Buch, dann die Warteschlangen aller anderen Bücher
   * übertragen; erst wenn nichts mehr offen ist (auch keine Konflikte), Anteil abgeben und den Zwischenspeicher löschen.
   */
  const finalize = useCallback(async () => {
    const k = key.current;
    const reason = expiringRef.current;
    if (!k || !reason) return;
    if (queue.current.length) await sync();
    const all = queueStore(userId, k.cacheKey, k.deviceId);
    const others: QueueStore = { ...all, books: async () => (await all.books()).filter((b) => b !== bookId) };
    const rest = await transferAllQueues(others, (b, ops) => offlineSyncAction(b, k.deviceId, ops).then((r) => (r.ok && r.results ? r.results : null)));
    setOtherBooks(rest.books);
    const left = queue.current.length + rest.remaining;
    if (left === 0) {
      await offlineDeactivateAction(k.deviceId).catch(() => undefined);
      await wipe();
      setConflicts([]);
      setStatus(idle);
      setError(`${expiringText(reason)} Alle Offline-Eingaben sind übertragen, der Zwischenspeicher ist gelöscht.`);
      return;
    }
    setError(
      `${expiringText(reason)} Noch nicht übertragen: ${left} ${left === 1 ? "Änderung" : "Änderungen"}` +
        `${rest.books ? ` (davon in ${books(rest.books)}, die du dort öffnest)` : ""} – bitte Konflikte klären; danach wird der Zwischenspeicher gelöscht.`,
    );
  }, [bookId, idle, sync, userId, wipe]);

  // Start: Gerät aus IndexedDB (dieses Kontos), Server-Anteil holen, Schlüssel ableiten, Warteschlange lesen, abgleichen
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!idbAvailable()) {
        setStatus("nicht-verfuegbar");
        return;
      }
      const dev = await loadDevice(userId).catch(() => null);
      if (cancelled) return;
      if (!dev) {
        setStatus(idle);
        return;
      }
      let r: Awaited<ReturnType<typeof offlineShareAction>>;
      try {
        r = await offlineShareAction(dev.deviceId);
      } catch {
        if (!cancelled) setStatus("keine-verbindung");
        return;
      }
      if (cancelled) return;
      if (r.gone) {
        // nicht mehr lesbar: nicht still löschen, sondern sagen, was verloren ist
        const lost = (await queuedBooks(userId, dev.deviceId).catch(() => [] as string[])).length;
        await wipe();
        setStatus(idle);
        if (lost)
          setError(
            `Der Offline-Zwischenspeicher dieses Geräts ist nicht mehr gültig (abgemeldet, ausgeschaltet oder Frist abgelaufen) – nicht übertragene Offline-Eingaben aus ${books(lost)} sind nicht mehr lesbar.`,
          );
        return;
      }
      try {
        const cacheKey = await deriveCacheKey(dev.deviceShare, r.share, dev.deviceId);
        key.current = { deviceId: dev.deviceId, cacheKey };
        // nicht lesbar: nicht still als leer behandeln, sondern sagen, dass Eingaben fehlen können
        const ops = await readQueue(userId, cacheKey, dev.deviceId, bookId).catch(() => {
          setError("Der Offline-Zwischenspeicher dieses Buchs ließ sich nicht lesen – nicht übertragene Offline-Eingaben fehlen möglicherweise.");
          return [] as OfflineOp[];
        });
        queue.current = ops;
        setPending(new Map(ops.map((o) => [cellKey(o.columnId, o.studentId), o])));
        setOtherBooks((await queuedBooks(userId, dev.deviceId).catch(() => [] as string[])).filter((b) => b !== bookId).length);
        setExpiresAt(r.expiresAt);
        setStatus("aktiv");
        if (r.keep) {
          if (ops.length) await sync();
        } else {
          expiringRef.current = r.reason;
          setExpiring(true);
          await finalize();
        }
      } catch {
        await wipe();
        setStatus(idle);
      }
    })();
    const up = () => void sync();
    window.addEventListener("online", up);
    return () => {
      cancelled = true;
      window.removeEventListener("online", up);
    };
  }, [bookId, finalize, idle, sync, userId, wipe]);

  const enqueue = useCallback<OfflineApi["enqueue"]>(
    async (op) => {
      if (status !== "aktiv" || !key.current || locked || expiringRef.current) return false;
      const before = queue.current;
      if (!(await setQueue(mergeOp(before, { ...op, opId: crypto.randomUUID(), at: new Date().toISOString() })))) {
        await setQueue(before);
        return false;
      }
      if (navigator.onLine) window.setTimeout(() => void sync(), 300);
      return true;
    },
    [locked, setQueue, status, sync],
  );

  const activate = useCallback<OfflineApi["activate"]>(
    async (confirmed) => {
      setError(null);
      const deviceId = crypto.randomUUID();
      let res: Awaited<ReturnType<typeof offlineActivateAction>>;
      try {
        res = await offlineActivateAction(deviceId, confirmed);
      } catch {
        setError("Keine Verbindung – zum Einschalten braucht es den Server.");
        return;
      }
      if (!res.ok || !res.share) {
        setError(res.error ?? "Einschalten nicht möglich");
        return;
      }
      try {
        const deviceShare = await importDeviceShare(randomBytes(SHARE_BYTES));
        await saveDevice(userId, { deviceId, deviceShare });
        key.current = { deviceId, cacheKey: await deriveCacheKey(deviceShare, res.share, deviceId) };
        queue.current = [];
        setPending(new Map());
        setExpiresAt(res.expiresAt ?? null);
        setStatus("aktiv");
      } catch {
        await wipe();
        setError("Der Browser konnte den Zwischenspeicher nicht anlegen (IndexedDB/WebCrypto).");
      }
    },
    [userId, wipe],
  );

  const deactivate = useCallback<OfflineApi["deactivate"]>(async () => {
    const deviceId = key.current?.deviceId;
    await wipe();
    setConflicts([]);
    setRejected([]);
    setStatus(idle);
    if (deviceId) await offlineDeactivateAction(deviceId).catch(() => undefined);
  }, [idle, wipe]);

  const resolve = useCallback<OfflineApi["resolve"]>(
    async (conflict, choice) => {
      const k = cellKey(conflict.op.columnId, conflict.op.studentId);
      setConflicts((prev) => prev.filter((c) => cellKey(c.op.columnId, c.op.studentId) !== k));
      if (choice === "server") cb.current.onServerValue(k, conflict.server);
      await setQueue(resolveInQueue(queue.current, conflict, choice, crypto.randomUUID(), new Date().toISOString()));
      if (choice === "mine") await sync();
      if (expiringRef.current) await finalize();
    },
    [finalize, setQueue, sync],
  );

  return useMemo(
    () => ({ status, decision, online, pending, otherBooks, expiring, conflicts, rejected, expiresAt, error, syncing, enqueue, sync, activate, deactivate, resolve }),
    [status, decision, online, pending, otherBooks, expiring, conflicts, rejected, expiresAt, error, syncing, enqueue, sync, activate, deactivate, resolve],
  );
}

function formatUntil(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(new Date(iso));
}

/** Bedienfeld über der Tabelle: Zustand, Einschalten (mit Bestätigung im Schulnetz), Abgleich, Ausschalten. */
export function OfflinePanel({ offline, locked }: { offline: OfflineApi; locked: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const { status, decision } = offline;
  if (status === "laedt" || status === "aus") return null;
  const needsConfirmation = decision.reason === "schulnetz";
  const count = offline.pending.size;
  const others = offline.otherBooks;

  return (
    <section aria-label="Offline-Eingabe" className="flex flex-col gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          Offline-Eingabe{" "}
          <span data-testid="offline-status" className="font-normal text-muted">
            {status === "aktiv" &&
              `${offline.expiring ? "läuft aus – nur noch Übertragen" : `aktiv auf diesem Gerät${offline.expiresAt ? ` (bis ${formatUntil(offline.expiresAt)})` : ""}`} · ${
                offline.online ? "verbunden" : "keine Verbindung"
              }${count ? ` · ${count} ${count === 1 ? "Änderung" : "Änderungen"} ausstehend` : ""}${offline.syncing ? " · wird übertragen …" : ""}`}
            {status === "bereit" && "auf diesem Gerät nicht eingeschaltet"}
            {status === "nicht-verfuegbar" && "auf diesem Gerät nicht verfügbar"}
            {status === "keine-verbindung" && "ohne Verbindung geöffnet – Eingaben werden nicht abgelegt"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {status === "aktiv" && count > 0 && offline.online && (
            <Button size="sm" disabled={offline.syncing} onClick={() => void offline.sync()}>
              Jetzt übertragen
            </Button>
          )}
          {status === "aktiv" && !confirmOff && (
            <Button size="sm" variant="ghost" onClick={() => (count > 0 || others > 0 ? setConfirmOff(true) : void offline.deactivate())}>
              Ausschalten
            </Button>
          )}
          {status === "bereit" && !locked && (
            <Button size="sm" variant="primary" disabled={needsConfirmation && !confirmed} onClick={() => void offline.activate(confirmed)}>
              Offline-Eingabe auf diesem Gerät einschalten
            </Button>
          )}
        </div>
      </div>
      {confirmOff && (
        <p role="alert" className="flex flex-wrap items-center gap-2">
          {count > 0 && `${count} ${count === 1 ? "Änderung ist" : "Änderungen sind"} hier noch nicht übertragen. `}
          {others > 0 && `In ${books(others)} auf diesem Gerät liegen weitere nicht übertragene Offline-Eingaben. `}
          Beim Ausschalten gehen sie verloren.
          <Button size="sm" variant="danger" onClick={() => void offline.deactivate().then(() => setConfirmOff(false))}>
            Trotzdem ausschalten
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>
            Abbrechen
          </Button>
        </p>
      )}
      {status === "bereit" && (
        <>
          <p className="text-muted">
            {OFFLINE_REASON_TEXT[decision.reason]} Ohne Verbindung landen Teilnoten in einem verschlüsselten Zwischenspeicher dieses Browsers und werden beim
            nächsten Kontakt abgeglichen (Konflikte werden angezeigt, nichts wird still überschrieben). Der Schlüssel entsteht nur zusammen mit einem Anteil des
            Servers – beim Abmelden (SchulOS warnt vorher) oder spätestens nach 7 Tagen ist der Zwischenspeicher unlesbar; die Sperre nach 15 Minuten ohne
            Eingabe lässt ihn stehen, nach der neuen Anmeldung wird übertragen. Halbjahresnoten, Spalten und Gewichte brauchen weiter eine Verbindung.
          </p>
          {needsConfirmation && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>Dies ist ein Dienstgerät der Schule (kein privates Gerät, § 2 Abs. 2 VO-DV I).</span>
            </label>
          )}
        </>
      )}
      {status === "nicht-verfuegbar" && (
        <p className="text-muted">
          {idbAvailable() ? OFFLINE_REASON_TEXT[decision.reason] : "Dieser Browser bietet keinen verschlüsselten Zwischenspeicher (IndexedDB/WebCrypto)."}
        </p>
      )}
      {offline.error && (
        <p role="alert" className="text-danger">
          {offline.error}
        </p>
      )}
      {offline.rejected.length > 0 && (
        <ul role="alert" className="text-danger">
          {offline.rejected.map((r) => (
            <li key={r.op.opId}>Offline-Eingabe abgelehnt: {r.reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Konflikte unter der Tabelle: Server-Wert gegen lokale Eingabe, bewusste Entscheidung je Zelle. */
export function OfflineConflicts({
  offline,
  label,
}: {
  offline: OfflineApi;
  /** „Max Mustermann, 1. Klassenarbeit“ für eine Änderung */
  label: (op: OfflineOp) => string;
}) {
  if (offline.conflicts.length === 0) return null;
  const show = (v: string | null | undefined) => (v ? v.replace(".", ",") : "leer");
  return (
    <section
      role="alert"
      aria-label="Konflikte beim Abgleich"
      className="flex flex-col gap-2 rounded-card border border-danger bg-danger-soft px-4 py-3 text-sm"
    >
      <p className="font-medium text-danger">
        {offline.conflicts.length === 1 ? "Eine Zelle wurde" : `${offline.conflicts.length} Zellen wurden`} inzwischen auf dem Server geändert – deine
        Offline-Eingabe dort ist nicht gespeichert. Bitte je Zelle entscheiden.
      </p>
      <ul className="flex flex-col gap-2">
        {offline.conflicts.map((c) => (
          <li key={c.op.opId} className="flex flex-wrap items-center gap-2">
            <span>
              <strong>{label(c.op)}</strong>: Server {show(c.server?.value)}
              {c.server?.comment ? ` („${c.server.comment}“)` : ""}
              {c.serverLabel ? ` von ${c.serverLabel}` : ""} · deine Eingabe {show(c.op.value)}
              {c.op.comment ? ` („${c.op.comment}“)` : ""}
            </span>
            <Button size="sm" onClick={() => void offline.resolve(c, "mine")}>
              Meine Eingabe übernehmen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void offline.resolve(c, "server")}>
              Server-Wert behalten
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
