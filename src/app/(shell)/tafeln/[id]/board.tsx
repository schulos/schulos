"use client";

// Tafel (P3-12): Excalidraw, gemeinsam über denselben Weg wie die Texte – geänderte Elemente gebündelt (250 ms) per POST,
// fremde über den Live-Kanal (SSE, Ereignis „tafel“). Abgleich je Element nach Version (Excalidraw `reconcileElements`,
// dieselbe Regel wie der Server in tafeln/scene.ts). Das Senden (Bündeln nach Anzahl und Bytes, Nachsenden, Ablehnungen,
// Rest beim Verlassen) steckt rein und getestet in modules/tafeln/outbox.ts. Wiederverbindung (live-open), Sichtbarwerden
// des Tabs und alle zwei Minuten: voller Stand vom Server, abgleichen, eigenes Neueres nachreichen. Nur dieses Modul lädt
// Excalidraw (über board-loader.tsx / next/dynamic).
//
// Web-Einbettungen und Bilder sind auf Tafeln aus (Server verwirft sie): das Werkzeug ist ausgeblendet (board.css), wird es
// trotzdem gewählt, springt die Auswahl zurück, und solche Elemente (auch aus der Bibliothek) fliegen lokal sofort raus (P312-01).
// Fremde Elemente laufen über restoreSafely: ein kaputtes Element wird einzeln verworfen, statt die Tafel lahmzulegen (G3B-01).
// Die Bibliothek bleibt (Q-P312-5), „Bibliotheken durchsuchen“ (externe Seite) und „Veröffentlichen“ sind ausgeblendet (G3B-05).
import "@excalidraw/excalidraw/index.css";
import "./board.css";
import { CaptureUpdateAction, Excalidraw, exportToBlob, exportToSvg, MainMenu, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { passiveHeaders } from "@schulos/ui/auto-refresh";
import { Button } from "@schulos/ui/button";
import { DROPPED_MESSAGE, learnKnown, Outbox, resetKnown, restoreSafely, revertElements, RevertQueue, stripDisallowed, type OutboxEvent, type Ver } from "@/modules/tafeln/outbox";
import type { LiveMessage } from "../../_shell/live";

const HEARTBEAT_MS = 120_000;

type El = OrderedExcalidrawElement;
type Remote = Parameters<typeof reconcileElements>[1];
type Status = "synced" | "pending" | "offline" | "readonly" | "removed" | { error: string };
interface SyncResponse {
  elements: El[];
  background: string;
  editors: number;
  crowded: boolean;
  canWrite: boolean;
  notSaved?: boolean;
}

/** Excalidraws restoreElements, aber kaputte Elemente einzeln verwerfen (G3B-01) */
function restore(remote: readonly El[]): El[] {
  const { elements, dropped } = restoreSafely(remote, (xs) => restoreElements(xs, null) as unknown as El[]);
  if (dropped.length) console.warn(`[tafel] ${dropped.length} defekte(s) Element(e) übersprungen`);
  return elements;
}

const post = (boardId: string, path: "update" | "sync", body: string, keepalive = false) =>
  fetch(`/api/tafeln/${boardId}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...passiveHeaders() }, body, credentials: "same-origin", keepalive });

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileBase = (title: string) => title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "tafel";

export function Board({ boardId, title, canWrite }: { boardId: string; title: string; canWrite: boolean }) {
  const { resolvedTheme } = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<Status>(canWrite ? "synced" : "readonly");
  /** Hinweis zu einer abgelehnten Änderung – die Tafel läuft weiter */
  const [notice, setNotice] = useState<string | null>(null);
  const [editors, setEditors] = useState(1);
  const [crowded, setCrowded] = useState(false);
  const [count, setCount] = useState(0);
  const [serverWritable, setServerWritable] = useState<boolean | null>(null);
  /** Speichern scheiterte am Kontingent des Gruppenordners (G3B-03) */
  const [notSaved, setNotSaved] = useState(false);
  const writable = (serverWritable ?? canWrite) && status !== "removed" && typeof status !== "object";
  /** Fassung je Element, die der Server hat (wird nur verändert, nie ersetzt – die Outbox hält dieselbe Map) */
  const known = useRef(new Map<string, Ver>());
  /** Signal an den Abgleich-Effekt: lokal hat sich etwas geändert */
  const changed = useRef<() => void>(() => {});

  // Erster Stand: über den Sync – Excalidraw wartet mit dem Zeichnen auf dieses Promise (erfüllt im Effekt unten)
  const [initial] = useState(() => {
    let resolve: (v: ExcalidrawInitialDataState | null) => void = () => {};
    const promise = new Promise<ExcalidrawInitialDataState | null>((r) => (resolve = r));
    return { promise, resolve };
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await post(boardId, "sync", "{}");
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          if (alive) setStatus(res.status === 404 ? "removed" : { error: j.error ?? "Die Tafel lässt sich nicht öffnen." });
          initial.resolve(null);
          return;
        }
        const j = (await res.json()) as SyncResponse;
        resetKnown(known.current, j.elements);
        if (alive) {
          setEditors(j.editors);
          setCrowded(j.crowded);
          setServerWritable(j.canWrite);
          setNotSaved(!!j.notSaved);
          if (!j.canWrite) setStatus("readonly");
        }
        initial.resolve({ elements: restore(j.elements), appState: { viewBackgroundColor: j.background }, scrollToContent: true });
      } catch {
        if (alive) setStatus("offline");
        initial.resolve(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [boardId, initial]);

  useEffect(() => {
    if (!api) return;
    let stopped = false;
    /** zurückzunehmende Elemente – bis ein Sync gelingt (G3B-04) */
    const reverts = new RevertQueue();

    const onEvent = (e: OutboxEvent) => {
      if (e.kind === "sending") setStatus((s) => (s === "synced" || s === "offline" ? "pending" : s));
      else if (e.kind === "synced") setStatus((s) => (s === "pending" || s === "offline" ? "synced" : s));
      else if (e.kind === "offline") setStatus((s) => (typeof s === "object" ? s : "offline"));
      else if (e.kind === "reply") {
        setEditors(e.editors);
        setCrowded(e.crowded);
        if (e.dropped) setNotice(`${DROPPED_MESSAGE}.`);
      } else if (e.kind === "readonly") {
        setServerWritable(false);
        setStatus("readonly");
      } else if (e.kind === "removed") setStatus("removed");
      else if (e.kind === "rejected") {
        // Grund zeigen, die abgelehnte Fassung durch den Serverstand ersetzen, weiterzeichnen geht (P312-01/04)
        setNotice(`${e.error} – die letzte Änderung wurde zurückgenommen.`);
        reverts.add(e.ids);
        if (!stopped) void sync();
      }
    };

    const outbox = writable
      ? new Outbox(
          {
            elements: () => api.getSceneElementsIncludingDeleted(),
            send: async (body, keepalive) => {
              const res = await post(boardId, "update", body, keepalive);
              return { status: res.status, json: () => res.json() };
            },
            emit: onEvent,
          },
          known.current,
        )
      : null;

    /** Fremde Elemente übernehmen (gewinnt nur, was neuer ist; was gerade bearbeitet wird, bleibt lokal) */
    const applyRemote = (remote: El[], replaceKnown: boolean, revert?: ReadonlySet<string>) => {
      const restored = restore(remote);
      if (replaceKnown) resetKnown(known.current, remote);
      else learnKnown(known.current, remote);
      let local: readonly El[] = api.getSceneElementsIncludingDeleted();
      if (revert?.size) {
        local = revertElements(local, restored, revert);
        outbox?.forgetRejected(revert);
      }
      const merged = reconcileElements(local, restored as unknown as Remote, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    };

    changed.current = () => outbox?.schedule();

    const sync = async () => {
      if (stopped) return;
      // jeder Sync nimmt die noch offenen Rücknahmen mit; vergessen werden sie erst nach Erfolg (G3B-04)
      const revert = reverts.take();
      try {
        const res = await post(boardId, "sync", "{}");
        if (!res.ok) {
          if (res.status === 404) setStatus("removed");
          return; // 429: der nächste Sync (Heartbeat, Verbindungsaufbau) holt es nach
        }
        const j = (await res.json()) as SyncResponse;
        if (stopped) return;
        applyRemote(j.elements, true, revert);
        reverts.done(revert);
        setNotSaved(!!j.notSaved);
        setEditors(j.editors);
        setCrowded(j.crowded);
        setServerWritable(j.canWrite);
        if (j.canWrite) outbox?.schedule(0); // eigenes Neueres nachreichen
        else setStatus("readonly");
      } catch {
        // nächster Sync (Heartbeat, Verbindungsaufbau)
      }
    };

    const onLive = (e: Event) => {
      const m = (e as CustomEvent<LiveMessage>).detail;
      if (m.type === "live-open") void sync();
      else if (m.type === "tafel" && m.boardId === boardId) {
        if (m.notSaved !== undefined) setNotSaved(m.notSaved);
        if (m.elements.length) applyRemote(m.elements as unknown as El[], false);
      }
    };
    window.addEventListener("schulos:live", onLive);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    const beat = setInterval(() => void sync(), HEARTBEAT_MS);
    // Tab wird geschlossen: Rest noch rausschicken (keepalive überlebt das Entladen; Grenze der Browser ~64 KB)
    const onHide = () => outbox?.sendRest();
    window.addEventListener("pagehide", onHide);
    // Änderungen, die vor diesem Effekt entstanden sind
    outbox?.schedule(0);

    return () => {
      stopped = true;
      changed.current = () => {};
      window.removeEventListener("schulos:live", onLive);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      clearInterval(beat);
      // erst den Rest senden, dann anhalten – auch beim Verlassen per Link (kein pagehide) (P312-05)
      outbox?.close();
    };
  }, [api, boardId, writable]);

  const exportImage = async (kind: "png" | "svg") => {
    if (!api) return;
    const elements = api.getSceneElements();
    const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false };
    if (kind === "png") download(await exportToBlob({ elements, appState, files: api.getFiles(), mimeType: "image/png" }), `${fileBase(title)}.png`);
    else {
      const svg = await exportToSvg({ elements, appState, files: api.getFiles() });
      download(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), `${fileBase(title)}.svg`);
    }
  };

  return (
    <section aria-label="Tafel" data-elements={count} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={!api} onClick={() => void exportImage("png")}>
          Als PNG
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={!api} onClick={() => void exportImage("svg")}>
          Als SVG
        </Button>
      </div>
      <div className="h-[70vh] min-h-[420px] overflow-hidden rounded-card border border-border">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initial.promise}
          langCode="de-DE"
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          viewModeEnabled={!writable}
          isCollaborating
          aiEnabled={false}
          name={title}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false, changeViewBackgroundColor: false, clearCanvas: writable, saveAsImage: true, toggleTheme: null },
            tools: { image: false },
          }}
          validateEmbeddable={false}
          onChange={(elements, appState) => {
            if (api) {
              if (appState.activeTool.type === "embeddable") api.setActiveTool({ type: "selection" });
              const kept = appState.newElement ? null : stripDisallowed(elements);
              if (kept) {
                api.updateScene({ elements: kept, captureUpdate: CaptureUpdateAction.NEVER });
                setNotice("Bilder und eingebettete Webseiten gehen auf Tafeln nicht – sie wurden entfernt.");
                return; // das folgende onChange zählt und meldet
              }
            }
            setCount(elements.reduce((n, el) => (el.isDeleted ? n : n + 1), 0));
            changed.current();
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            {writable && <MainMenu.DefaultItems.ClearCanvas />}
          </MainMenu>
        </Excalidraw>
      </div>
      <StatusLine status={status} editors={editors} crowded={crowded} writable={writable} notSaved={notSaved} />
      {notice && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <span>{notice}</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => setNotice(null)}>
            Ausblenden
          </Button>
        </p>
      )}
    </section>
  );
}

function StatusLine({ status, editors, crowded, writable, notSaved }: { status: Status; editors: number; crowded: boolean; writable: boolean; notSaved: boolean }) {
  let text: string;
  const danger = typeof status === "object" || status === "offline" || (notSaved && status !== "removed");
  if (typeof status === "object") text = status.error;
  else if (status === "removed") text = "Diese Tafel wurde gelöscht.";
  else if (status === "readonly" || !writable) text = "Nur ansehen";
  else if (status === "pending") text = "Speichert …";
  else if (status === "offline") text = "Keine Verbindung – Änderungen werden nachgereicht";
  else if (notSaved) text = "Nicht gespeichert – der Speicher des Gruppenordners ist voll (in „Dateien“ aufräumen)";
  else text = "Gespeichert";
  const people = editors > 1 ? ` · ${editors} Personen dabei` : "";
  return (
    <p role="status" aria-live="polite" className={`flex flex-wrap items-center gap-2 text-xs ${danger ? "text-danger" : "text-muted"}`}>
      <span>
        {text}
        {people}
        {crowded && " · Sehr viele gleichzeitig – das kann träge werden"}
      </span>
      {typeof status === "object" && (
        <Button type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>
          Neu laden
        </Button>
      )}
    </p>
  );
}
