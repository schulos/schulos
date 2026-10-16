import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { logoUrl, type LogoMeta } from "@/core/school/logo-meta";
import { getSchoolSettings } from "@/core/settings";
import { ThemeProvider } from "@schulos/ui/theme";
import "./globals.css";

// lokal mitgeliefert (packages/ui/fonts, OFL) – der Build lädt nichts aus dem Netz (TD-04)
const display = localFont({ src: "../../packages/ui/fonts/bricolage-grotesque-latin-wght-normal.woff2", weight: "200 800", variable: "--font-bricolage" });
const sans = localFont({ src: "../../packages/ui/fonts/figtree-latin-wght-normal.woff2", weight: "300 900", variable: "--font-figtree" });

const STATIC_ICON = { url: "/icon.png", type: "image/png", sizes: "512x512" };

/**
 * Favicon (P4-04, Q-10): Symbol der Schule aus der Logo-Route, davor das statische SchulOS-PNG als Rückfall
 * (Safari kann kein SVG-Favicon; ohne Symbol bleibt es beim PNG).
 */
export async function generateMetadata(): Promise<Metadata> {
  await headers(); // je Anfrage – nie beim Build aus der Datenbank lesen
  let symbol: LogoMeta | undefined;
  try {
    symbol = (await getSchoolSettings()).logos.symbol;
  } catch {
    // Datenbank nicht erreichbar: Seite kommt trotzdem, nur mit dem statischen Symbol
  }
  const icon = symbol
    ? [STATIC_ICON, { url: logoUrl("symbol", symbol), type: symbol.mime, sizes: symbol.mime === "image/svg+xml" ? "any" : `${symbol.width}x${symbol.height}` }]
    : [STATIC_ICON];
  return {
    title: { default: "SchulOS", template: "%s · SchulOS" },
    description: "Das Betriebssystem für die Schule",
    icons: { icon, apple: "/icon.png" },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce aus dem Proxy (CSP) – für das Inline-Skript von next-themes, das das Farbschema vor dem Rendern setzt
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="de" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
