"use client";

import dynamic from "next/dynamic";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/**
 * Excalidraw nur auf der Tafelseite laden (P3-12): eigener Chunk über next/dynamic, ohne SSR (Excalidraw braucht `window`).
 * Schriften kommen von SchulOS selbst (`public/excalidraw/fonts`, scripts/excalidraw-fonts.mjs) – ohne den Pfad lädt
 * Excalidraw sie aus dem Netz (CDN), was die CSP ohnehin blockiert (TD-04: keine externen Ressourcen).
 */
const Board = dynamic(
  () => {
    window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
    return import("./board").then((m) => m.Board);
  },
  {
    ssr: false,
    loading: () => (
      <div role="status" className="flex h-[70vh] items-center justify-center rounded-card border border-border bg-surface text-muted">
        Tafel wird geladen …
      </div>
    ),
  },
);

export function BoardLoader(props: { boardId: string; title: string; canWrite: boolean }) {
  return <Board {...props} />;
}
