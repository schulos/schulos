import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceWorkerSource } from "@/core/pwa/service-worker";

export const dynamic = "force-dynamic";

/** Build-ID als Version des Service Workers (neuer Build → neuer Cache-Name, alte Caches werden geräumt). */
function buildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

const VERSION = buildId();

/**
 * Service Worker der PWA (P4-73, src/core/pwa/service-worker.ts). Ohne Anmeldung abrufbar (public-paths): der Browser prüft
 * ihn auch auf der Anmeldeseite auf Updates. Nie zwischenspeichern – sonst bleiben Updates hängen.
 */
export function GET() {
  return new Response(serviceWorkerSource(VERSION), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache, max-age=0",
      "service-worker-allowed": "/",
    },
  });
}
