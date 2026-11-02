"use client";

import { useActionState, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closeInventoryAction, deleteInventoryAction, scanInventoryAction, scanInventoryFormAction } from "@/modules/gebaeude/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";

// Minimal-Typen der Barcode Detection API (nicht in lib.dom): nur, was der In-App-Scan braucht.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

const SCAN_INTERVAL_MS = 250;
/** derselbe Code wird erst nach dieser Pause erneut gemeldet (Kamera sieht ihn sonst mehrmals je Sekunde) */
const SAME_CODE_PAUSE_MS = 4000;

const noSubscribe = () => () => {};

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return ((window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null) as BarcodeDetectorCtor | null;
}

/**
 * INV-04 Erfassen auf der Inventurseite: Eingabezeile für Code/Kurz-URL/Inventarnummer (auch Handscanner, die wie eine Tastatur
 * tippen) und – nur wenn der Browser die Barcode-Erkennung kann (BarcodeDetector) – der In-App-Scan mit der Rückkamera. Sonst
 * bleibt der Weg über die Kamera-App des Handys (Etikett öffnet die Geräteseite mit dem Knopf „gefunden“).
 */
export function ScanBox({ inventoryId }: { inventoryId: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<FormState, FormData>(scanInventoryFormAction.bind(null, inventoryId), {});
  // Fähigkeit des Browsers erst im Client (Server rendert ohne Kamera-Knopf)
  const supported = useSyncExternalStore(noSubscribe, () => detectorCtor() !== null, () => false);
  const [camera, setCamera] = useState<"off" | "starting" | "on">("off");
  const [camMessage, setCamMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  useEffect(() => () => stop(), []);

  function stop() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  async function start() {
    const Ctor = detectorCtor();
    if (!Ctor) return;
    setCamera("starting");
    setCamMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setCamera("on");
      const detector = new Ctor({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          const code = codes[0]?.rawValue;
          const now = Date.now();
          if (code && (code !== lastRef.current.code || now - lastRef.current.at > SAME_CODE_PAUSE_MS)) {
            lastRef.current = { code, at: now };
            const r = await scanInventoryAction(inventoryId, code);
            setCamMessage({ ok: r.ok, text: r.message });
            if (r.ok) {
              navigator.vibrate?.(60);
              router.refresh();
            }
          }
        } catch {
          // einzelne Bilder ohne Ergebnis ignorieren
        }
        if (streamRef.current) timerRef.current = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      timerRef.current = setTimeout(tick, SCAN_INTERVAL_MS);
    } catch (err) {
      stop();
      setCamera("off");
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setCamMessage({
        ok: false,
        text: denied
          ? "Kamera nicht freigegeben – bitte im Browser erlauben oder das Etikett mit der Kamera-App scannen."
          : "Kamera lässt sich nicht starten – bitte das Etikett mit der Kamera-App scannen oder die Nummer eingeben.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} aria-label="Code oder Inventarnummer erfassen" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Code oder Inventarnummer" error={state.fieldErrors?.code} className="min-w-0 flex-1 basis-56">
            <Input name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} required placeholder="z. B. IT-0042" />
          </Field>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Erfassen …" : "Erfassen"}
          </Button>
        </div>
        {state.ok && state.message && (
          <p role="status" className="text-sm text-success">
            {state.message}
          </p>
        )}
      </form>
      {supported && (
        <div className="flex flex-col gap-2">
          <div>
            {camera === "on" || camera === "starting" ? (
              <Button
                onClick={() => {
                  stop();
                  setCamera("off");
                }}
              >
                Kamera beenden
              </Button>
            ) : (
              <Button onClick={() => void start()}>Mit der Kamera scannen</Button>
            )}
          </div>
          <video ref={videoRef} muted playsInline aria-label="Kamerabild zum Scannen" className={camera === "on" ? "aspect-[4/3] w-full max-w-md rounded-xl bg-surface-2 object-cover" : "hidden"} />
          <p role="status" aria-live="polite" className={camMessage?.ok === false ? "text-sm text-danger" : "text-sm text-success"}>
            {camMessage?.text ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}

/** Inventur abschließen (Rückfrage: Offenes wird „fehlt“). */
export function CloseInventory({ id, open }: { id: string; open: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="primary"
      disabled={pending}
      className="w-full sm:w-auto"
      onClick={() => {
        if (confirm(open > 0 ? `Inventur abschließen? ${open === 1 ? "Ein offener Posten wird" : `${open} offene Posten werden`} als „fehlt“ eingetragen.` : "Inventur abschließen?"))
          start(() => closeInventoryAction(id));
      }}
    >
      Inventur abschließen
    </Button>
  );
}

/** Laufende Inventur abbrechen bzw. abgeschlossenes Protokoll löschen (Rückfrage). */
export function DeleteInventory({ id, closed }: { id: string; closed: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      disabled={pending}
      className="text-danger"
      onClick={() => {
        if (confirm(closed ? "Protokoll dieser Inventur endgültig löschen?" : "Inventur abbrechen? Alle Erfassungen gehen verloren.")) start(() => deleteInventoryAction(id));
      }}
    >
      {closed ? "Protokoll löschen" : "Inventur abbrechen"}
    </Button>
  );
}
