// Next ruft register() einmal beim Serverstart auf und wartet darauf, bevor Anfragen angenommen werden.
// Schlägt der Start fehl (Migration, falscher Instanztyp, fehlende Konfiguration), beendet sich der Prozess –
// Next würde sonst weiterlaufen und jede Anfrage mit Fehler beantworten.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startup } = await import("./core/startup");
  try {
    await startup();
  } catch (err) {
    console.error(`[schulos] Start abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
