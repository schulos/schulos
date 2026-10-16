import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "@schulos/server/security-headers";

const nextConfig: NextConfig = {
  // Container-Image: eigenständiger Server unter .next/standalone
  output: "standalone",
  // Der Tracer folgt path.join(cwd, ".data", …) – lokale Daten dürfen nie ins Image
  outputFileTracingExcludes: { "**": [".data/**"] },
  // PGlite bringt eigene WASM-Dateien mit und darf nicht gebündelt werden.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  // Reproduzierbarer Bau (B-47): fester Build-Name aus dem Commit statt Zufall (Dockerfile, ARG SCHULOS_BUILD_ID)
  generateBuildId: async () => process.env.SCHULOS_BUILD_ID || null,
  // Feste Sicherheits-Header wie im Hauptsystem; die CSP mit Nonce setzt src/proxy.ts je Anfrage
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },
};

export default nextConfig;
