import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { ThemeProvider } from "@schulos/ui/theme";
import "./globals.css";

// lokal mitgeliefert (packages/ui/fonts, OFL) – der Build lädt nichts aus dem Netz (TD-04)
const display = localFont({ src: "../../../../packages/ui/fonts/bricolage-grotesque-latin-wght-normal.woff2", weight: "200 800", variable: "--font-bricolage" });
const sans = localFont({ src: "../../../../packages/ui/fonts/figtree-latin-wght-normal.woff2", weight: "300 900", variable: "--font-figtree" });

export const metadata: Metadata = {
  title: { default: "SchulOS Backup", template: "%s · SchulOS Backup" },
  description: "Backupserver für SchulOS",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce aus dem Proxy (CSP) – für das Inline-Skript von next-themes
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="de" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
