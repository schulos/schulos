// Next ruft register() einmal beim Serverstart auf und wartet darauf, bevor Anfragen angenommen werden.
// Schlägt der Start fehl (Migration, fehlende Konfiguration), beendet sich der Prozess.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startup } = await import("./startup");
  try {
    await startup();
  } catch (err) {
    console.error(`[backup] Start abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
