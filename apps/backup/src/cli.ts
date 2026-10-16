// Kommandozeile im Backup-Container (B-45): `docker compose exec backup node cli.mjs <befehl>` – z. B. per SSH auf dem
// Backupserver, im Installer-Erststart oder in den QEMU-Tests. Spricht die laufende App über die interne API an (src/intern.ts).
//   kopplungscode                  neuer Kopplungscode für ein Hauptsystem (24 h gültig) – auf stdout
//   kopplungscode --ersatz <inst>  Ersatz-Kopplungscode (neue Hardware) für eine Instanz (Name, Kennung oder rest-Benutzer)
//   instanzen                      gekoppelte Instanzen als JSON
import { BACKUP_CONFIG_FILE, loadConfig } from "@schulos/server/config";
import { INTERN_HEADER, internToken } from "./intern";

const USAGE = "Aufruf: node cli.mjs kopplungscode [--ersatz <instanz>] | instanzen";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "kopplungscode" && cmd !== "instanzen") {
    console.error(USAGE);
    return 2;
  }
  loadConfig(process.env, BACKUP_CONFIG_FILE, { generateSecret: false });
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    console.error("Kein App-Geheimnis (secret.env) – läuft der Backupserver schon einmal gestartet?");
    return 1;
  }
  const base = `http://127.0.0.1:${process.env.PORT ?? 3100}/api/intern`;
  const headers = { [INTERN_HEADER]: internToken(secret), "content-type": "application/json" };
  if (cmd === "instanzen") {
    const r = await fetch(`${base}/instanzen`, { headers });
    console.log(JSON.stringify(await r.json(), null, 2));
    return r.ok ? 0 : 1;
  }
  const i = rest.indexOf("--ersatz");
  const ersatz = i >= 0 ? rest[i + 1] : undefined;
  if (i >= 0 && !ersatz) {
    console.error(USAGE);
    return 2;
  }
  const r = await fetch(`${base}/kopplungscode`, { method: "POST", headers, body: JSON.stringify(ersatz ? { ersatz } : {}) });
  const body = (await r.json()) as { code?: string; gueltigBis?: string; error?: string; instanzen?: { id: string; name: string }[] };
  if (!r.ok || !body.code) {
    console.error(body.error ?? `Fehler ${r.status}`);
    for (const x of body.instanzen ?? []) console.error(`  ${x.id}  ${x.name}`);
    return 1;
  }
  console.error(`${ersatz ? "Ersatz-Kopplungscode" : "Kopplungscode"}, gültig bis ${body.gueltigBis}:`);
  console.log(body.code);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
