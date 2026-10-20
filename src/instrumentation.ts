// Next ruft register() einmal beim Serverstart auf und wartet darauf, bevor Anfragen angenommen werden.
// Schlägt der Start fehl (Migration, falscher Instanztyp, fehlende Konfiguration), beendet sich der Prozess –
// Next würde sonst weiterlaufen und jede Anfrage mit Fehler beantworten.
export async function register() {
  // Der Import steht im if-Zweig (nicht hinter einem frühen return): Webpack baut instrumentation.ts auch für die Edge-Schicht
  // und entfernt nur einen if-Zweig mit der ersetzten Konstante als toten Code. Ein früher return ließ den Import stehen, und
  // `next dev --webpack` scheiterte an „node:child_process“ (nodemailer in startup.ts).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startup } = await import("./core/startup");
    try {
      await startup();
    } catch (err) {
      console.error(`[schulos] Start abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}
