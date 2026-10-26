"use client";

// Editor für Texte (P3-11): Tiptap + Yjs, ohne WebSocket. Lokale Änderungen gehen gebündelt (300 ms) per POST an den
// Server, fremde kommen über den gemeinsamen Live-Kanal (SSE, Ereignis „text“). Verpasstes holt ein Sync über den
// Zustandsvektor – beim Öffnen, bei jedem (Neu-)Aufbau der Live-Verbindung, beim Sichtbarwerden des Tabs und alle zwei
// Minuten. Scheitert ein POST, bleibt das Update in der Warteschlange und geht mit Backoff erneut raus (Yjs: doppelt
// anwenden ist wirkungslos). Keine Awareness (Cursor anderer) – bewusst weggelassen, bis es einen Rückkanal dafür gibt.
import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading1, Heading2, Italic, List, ListOrdered, Quote, Redo2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import * as Y from "yjs";
import { deleteDocAction, updateDocAction } from "@/modules/texte/actions";
import { hasUnconfirmedChanges, warnBeforeLeave, type EditorStatus } from "@/modules/texte/leave";
import type { FormState } from "@/modules/verwaltung/actions";
import { passiveHeaders, passiveRefresh } from "@schulos/ui/auto-refresh";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import type { LiveMessage } from "../../_shell/live";
import { MODES } from "../new-doc";

const FLUSH_MS = 300;
const HEARTBEAT_MS = 120_000;
const MAX_BACKOFF_MS = 10_000;

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** `error`: der Server hat eine Änderung endgültig abgelehnt – weitere Updates bauten darauf auf, also Seite neu laden */
type Status = EditorStatus;

const EDITOR_CLASS =
  "min-h-[50vh] rounded-card border border-border bg-surface px-5 py-4 leading-relaxed outline-none whitespace-pre-wrap break-words focus:border-accent " +
  "[&_h1]:mt-4 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1.5 " +
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted " +
  "[&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-surface-2 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:font-mono [&_pre]:text-sm [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_a]:text-accent-ink [&_a]:underline [&_hr]:my-3 [&_hr]:border-border";

export function TextEditor({ docId, initialState, canWrite }: { docId: string; initialState: string; canWrite: boolean }) {
  const router = useRouter();
  const [ydoc] = useState(() => {
    const d = new Y.Doc();
    if (initialState) Y.applyUpdate(d, fromB64(initialState), "remote");
    return d;
  });
  const [status, setStatus] = useState<Status>("synced");
  const [editors, setEditors] = useState(1);
  const [crowded, setCrowded] = useState(false);
  // Schreibrecht: bis zum ersten Sync das der Seite, danach das vom Server gemeldete (ändert sich live mit dem Modus)
  const [serverWritable, setServerWritable] = useState<boolean | null>(null);
  const writable = serverWritable ?? canWrite;
  // Noch nicht bestätigte Updates (Warteschlange oder laufender POST) – greift auch im Fenster, bevor der Status umspringt
  const unsent = useRef(false);

  // TD-06: Tab schließen/neu laden mit unbestätigten Änderungen → Rückfrage des Browsers (pagehide schickt den Rest zwar noch
  // per keepalive, eine Rückmeldung gibt es dort aber nicht). In-App-Navigation fängt das Repo sonst nirgends ab.
  const unconfirmed = hasUnconfirmedChanges(status, false);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => warnBeforeLeave(e, unconfirmed || unsent.current);
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unconfirmed]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: canWrite,
      extensions: [StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }), Collaboration.configure({ document: ydoc })],
      editorProps: { attributes: { class: EDITOR_CLASS, role: "textbox", "aria-multiline": "true", "aria-label": "Textinhalt" } },
    },
    [ydoc],
  );

  useEffect(() => {
    editor?.setEditable(writable && status !== "removed");
  }, [editor, writable, status]);

  useEffect(() => {
    let queue: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let backoff = FLUSH_MS;
    let stopped = false;

    const post = (path: "update" | "sync", body: unknown, keepalive = false) =>
      fetch(`/api/texte/${docId}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...passiveHeaders() }, body: JSON.stringify(body), credentials: "same-origin", keepalive });

    const schedule = (ms: number) => {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, ms);
    };

    const retry = (batch: Uint8Array) => {
      queue.unshift(batch);
      setStatus("offline");
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      schedule(backoff);
    };

    const flush = async () => {
      if (inflight || stopped || queue.length === 0) return;
      inflight = true;
      const batch = queue.length === 1 ? queue[0]! : Y.mergeUpdates(queue);
      queue = [];
      try {
        const res = await post("update", { update: toB64(batch) });
        if (res.ok) {
          const j = (await res.json()) as { editors: number; crowded: boolean };
          setEditors(j.editors);
          setCrowded(j.crowded);
          backoff = FLUSH_MS;
          if (queue.length === 0) setStatus("synced");
        } else if (res.status === 403) {
          setServerWritable(false);
          setStatus("readonly");
        } else if (res.status === 404) {
          setStatus("removed");
        } else if (res.status === 400 || res.status === 413) {
          // endgültig abgelehnt: alles Weitere dieses Tabs baute auf dem Abgelehnten auf (Yjs-Uhr) und bliebe beim Server
          // hängen – deshalb nichts mehr senden und zum Neuladen auffordern (der Serverstand ist der gültige)
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          stopped = true;
          queue = [];
          setStatus({ error: j.error ?? "Die Änderung wurde abgelehnt." });
        } else retry(batch);
      } catch {
        retry(batch);
      } finally {
        inflight = false;
        unsent.current = queue.length > 0;
        if (queue.length) schedule(backoff);
      }
    };

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || stopped) return;
      queue.push(update);
      unsent.current = true;
      setStatus((s) => (s === "offline" ? s : "pending"));
      schedule(FLUSH_MS);
    };
    ydoc.on("update", onUpdate);

    const sync = async () => {
      if (stopped) return;
      try {
        const res = await post("sync", { sv: toB64(Y.encodeStateVector(ydoc)) });
        if (!res.ok) {
          if (res.status === 404) setStatus("removed");
          return;
        }
        const j = (await res.json()) as { update: string; sv: string; editors: number; crowded: boolean; canWrite: boolean };
        Y.applyUpdate(ydoc, fromB64(j.update), "remote");
        setEditors(j.editors);
        setCrowded(j.crowded);
        setServerWritable(j.canWrite);
        if (j.canWrite) {
          // was der Server von uns noch nicht hat (verlorener POST, Bearbeitung ohne Verbindung). Der Diff trägt immer das
          // ganze DeleteSet mit – nur schicken, wenn er neue Inhalte (Structs) enthält; reine Löschungen hängen ohnehin in der
          // Warteschlange, und der Server ignoriert Wirkungsloses (P311-01)
          const missing = Y.encodeStateAsUpdate(ydoc, fromB64(j.sv));
          if (missing.length > 2 && Y.parseUpdateMeta(missing).to.size > 0) {
            queue.push(missing);
            // Review R3 N3: auch das ist unbestätigt – sonst warnt das Schließen nicht, solange es unterwegs ist
            unsent.current = true;
            setStatus((s) => (s === "synced" ? "pending" : s));
            schedule(0);
          }
        }
        if (queue.length === 0 && !inflight) setStatus((s) => (s === "removed" || s === "readonly" ? s : "synced"));
      } catch {
        // nächster Sync (Heartbeat, Verbindungsaufbau)
      }
    };
    void sync();

    const onLive = (e: Event) => {
      const m = (e as CustomEvent<LiveMessage>).detail;
      if (m.type === "live-open") void sync();
      else if (m.type === "text" && m.docId === docId) {
        if (m.update) Y.applyUpdate(ydoc, fromB64(m.update), "remote");
        if (m.removed) setStatus("removed");
        if (m.title) {
          passiveRefresh(router); // G4E-C01: Live-Ereignis, keine Aktivität der Person
          void sync(); // Modus kann sich mit geändert haben
        }
      }
    };
    window.addEventListener("schulos:live", onLive);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    const beat = setInterval(() => void sync(), HEARTBEAT_MS);
    // Tab wird geschlossen: Rest noch rausschicken (keepalive überlebt das Entladen)
    const onHide = () => {
      if (queue.length === 0) return;
      const batch = Y.mergeUpdates(queue);
      queue = [];
      void post("update", { update: toB64(batch) }, true).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);

    return () => {
      stopped = true;
      ydoc.off("update", onUpdate);
      window.removeEventListener("schulos:live", onLive);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      onHide();
    };
  }, [docId, ydoc, router]);

  return (
    <section aria-label="Text" className="flex flex-col gap-2">
      {writable && status !== "removed" && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      <StatusLine status={status} editors={editors} crowded={crowded} writable={writable} />
    </section>
  );
}

function StatusLine({ status, editors, crowded, writable }: { status: Status; editors: number; crowded: boolean; writable: boolean }) {
  let text: string;
  if (typeof status === "object") text = status.error;
  else if (status === "removed") text = "Dieser Text wurde gelöscht.";
  else if (status === "readonly" || !writable) text = "Nur lesen";
  else if (status === "pending") text = "Speichert …";
  else if (status === "offline") text = "Keine Verbindung – Änderungen werden nachgereicht";
  else text = "Gespeichert";
  const people = editors > 1 ? ` · ${editors} Personen dabei` : "";
  return (
    <p role="status" aria-live="polite" className={`flex flex-wrap items-center gap-2 text-xs ${typeof status === "object" || status === "offline" ? "text-danger" : "text-muted"}`}>
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

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      code: e.isActive("codeBlock"),
    }),
  });
  const c = () => editor.chain().focus();
  const items: { label: string; icon: React.ReactNode; on: boolean; run: () => void }[] = [
    { label: "Überschrift 1", icon: <Heading1 aria-hidden />, on: active.h1, run: () => c().toggleHeading({ level: 1 }).run() },
    { label: "Überschrift 2", icon: <Heading2 aria-hidden />, on: active.h2, run: () => c().toggleHeading({ level: 2 }).run() },
    { label: "Fett", icon: <Bold aria-hidden />, on: active.bold, run: () => c().toggleBold().run() },
    { label: "Kursiv", icon: <Italic aria-hidden />, on: active.italic, run: () => c().toggleItalic().run() },
    { label: "Aufzählung", icon: <List aria-hidden />, on: active.bullet, run: () => c().toggleBulletList().run() },
    { label: "Nummerierung", icon: <ListOrdered aria-hidden />, on: active.ordered, run: () => c().toggleOrderedList().run() },
    { label: "Zitat", icon: <Quote aria-hidden />, on: active.quote, run: () => c().toggleBlockquote().run() },
    { label: "Code", icon: <Code aria-hidden />, on: active.code, run: () => c().toggleCodeBlock().run() },
  ];
  return (
    <div role="toolbar" aria-label="Formatierung" className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Button key={i.label} type="button" size="sm" variant={i.on ? "secondary" : "ghost"} aria-label={i.label} aria-pressed={i.on} onClick={i.run}>
          {i.icon}
        </Button>
      ))}
      <span className="mx-1 w-px bg-border" aria-hidden />
      <Button type="button" size="sm" variant="ghost" aria-label="Rückgängig" onClick={() => c().undo().run()}>
        <Undo2 aria-hidden />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label="Wiederholen" onClick={() => c().redo().run()}>
        <Redo2 aria-hidden />
      </Button>
    </div>
  );
}

export function DocSettings({ docId, title, mode }: { docId: string; title: string; mode: string }) {
  const [t, setT] = useState(title);
  const [m, setM] = useState(mode);
  const [state, formAction, pending] = useActionState(updateDocAction.bind(null, docId), {} as FormState);
  const [deleting, start] = useTransition();
  return (
    <form action={formAction} aria-label="Text verwalten" className="flex flex-wrap items-end gap-2">
      <Field label="Titel" error={state.fieldErrors?.title}>
        <Input name="title" value={t} onChange={(e) => setT(e.target.value)} maxLength={120} required />
      </Field>
      <Field label="Wer schreibt?">
        <Select name="mode" value={m} onChange={(e) => setM(e.target.value)}>
          {MODES.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        Speichern
      </Button>
      <Button
        type="button"
        variant="danger"
        disabled={deleting}
        onClick={() => {
          if (confirm("Text mit seinem ganzen Inhalt löschen?")) start(() => deleteDocAction(docId));
        }}
      >
        Text löschen
      </Button>
      {state.ok && (
        <p role="status" className="basis-full text-sm text-muted">
          Gespeichert.
        </p>
      )}
      {state.error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
