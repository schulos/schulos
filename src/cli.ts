// Kommandozeile im App-Container für schulosctl (B-31): `node cli.mjs <befehl>` (gebündelt mit scripts/build-cli.mjs).
// Dieselbe Konfiguration und Datenbank wie die App (loadConfig + DATABASE_URL bzw. PGLITE_DIR), migriert vorher.
//   info                  Version, Instanztyp, Datenbank, Kontenzahl je Rolle, Migrationen – als JSON, ohne Personendaten
//   reset-admin [name]    Admin-Zugang wiederherstellen (neues Passwort, 2FA aus, Sperre weg, Schulnetz-Bereiche auf Vorgabe) –
//                         Passwort einmal auf stdout
//   schulnetz-zuruecksetzen  Schulnetz-Bereiche (Verwaltung → System → Anmeldung) auf die Vorgabe zurück (G4E-C02, Aussperren)
//   demo-reset            Demo-Instanz zurücksetzen (App vorher stoppen – PGlite/Jobs; schulosctl erledigt das)
//   probe                 Rauchtest im Probelauf-Container gegen die eigene App (technisches Konto) – JSON
//   schulprofil-export    Schulprofil der Schule (P4-77, ohne Personendaten) als JSON auf stdout
//   schulprofil-import <datei>  Schulprofil in diese Demo-/Vorschau-Instanz einspielen – Bericht als JSON
//   (demo-reset spielt danach automatisch `SCHULOS_SCHULPROFIL` bzw. `<SCHULOS_CONFIG_DIR>/schulprofil.json` ein, falls vorhanden)
//   geraete-ca-pruefen    Schul-CA (P4-40b): Testzertifikat über step-ca ausstellen lassen und prüfen (ohne Eintrag) – JSON
//   virenscan-pruefen     Virenscan (P4-72): EICAR-Testdatei muss gefunden, eine harmlose Datei durchgelassen werden – JSON
//   crowdsec-pruefen [ip] CrowdSec (SEC-15): Einstellung, Abgleich der Sperren, ist <ip> gesperrt? – JSON (Diagnose)
import { existsSync, readFileSync } from "node:fs";
import { activeBans, crowdsecConfig, emptyCache, isBanned, pull } from "@/core/crowdsec";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { loadConfig } from "@schulos/server/config";
import { getDbHandle, rowsOf } from "@/core/db/client";
import { localStorage } from "@/core/files/storage";
import { instanceTypeInDb } from "@/core/instance";
import { countByRole } from "@/modules/verwaltung/users";
import { demoReset, OpsError, probeSmoke, resetAdmin } from "@/core/ops";
import { resetSchoolNets } from "@/core/auth/anmelde-einstellungen";
import { checkDeviceCa } from "@/core/device-certs/check";
import { MODULES } from "@/modules";
import { buildSchulprofil, importSchulprofil, parseSchulprofil } from "@/modules/verwaltung/schulprofil";
import { ValidationError } from "@/modules/verwaltung/users";
import { clamavTarget, clamavVersion, EICAR, encryptedZipSample, scanBuffer } from "@/core/files/virus-scan";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "geraete-ca-pruefen") {
    // ohne Datenbank: nur die Schul-CA
    const r = await checkDeviceCa(process.env);
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  if (cmd === "crowdsec-pruefen") {
    // ohne Datenbank: Sicht der App auf CrowdSec (Einstellung, Abgleich, ist <ip> gesperrt?) – Diagnose für CI und Betrieb
    const cfg = crowdsecConfig(process.env);
    if (!cfg) {
      console.log(JSON.stringify({ ok: false, error: "SCHULOS_CROWDSEC_URL/SCHULOS_CROWDSEC_BOUNCER_KEY nicht gesetzt" }));
      return 1;
    }
    const cache = emptyCache();
    await pull(cfg, cache);
    const ip = args[0];
    console.log(JSON.stringify({ ok: cache.error === null, url: cfg.url, aktiv: activeBans(cache), fehler: cache.error, ...(ip ? { ip, gesperrt: isBanned(cache, ip) } : {}) }));
    return cache.error === null ? 0 : 1;
  }
  if (cmd === "virenscan-pruefen") {
    // ohne Datenbank: nur clamd über SCHULOS_CLAMAV
    const target = clamavTarget(process.env);
    if (!target) {
      console.log(JSON.stringify({ ok: false, error: "SCHULOS_CLAMAV nicht gesetzt" }));
      return 1;
    }
    try {
      const version = await clamavVersion(target);
      const eicar = await scanBuffer(new TextEncoder().encode(EICAR), target);
      const clean = await scanBuffer(new TextEncoder().encode("SchulOS – harmlose Testdatei\n"), target);
      // G4E-O09: verschlüsseltes ZIP muss als Fund gelten (strenge clamd-Einstellungen aus compose.yaml)
      const zip = await scanBuffer(encryptedZipSample(), target);
      const ok = !eicar.clean && clean.clean && !zip.clean;
      console.log(JSON.stringify({ ok, version, eicar: eicar.signature, harmlos: clean.clean, verschluesselt: zip.signature }));
      return ok ? 0 : 1;
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return 1;
    }
  }
  if (!cmd || !["info", "reset-admin", "schulnetz-zuruecksetzen", "demo-reset", "probe", "schulprofil-export", "schulprofil-import"].includes(cmd)) {
    console.error(
      "Aufruf: node cli.mjs info | reset-admin [benutzername] | schulnetz-zuruecksetzen | demo-reset | probe | schulprofil-export | schulprofil-import <datei> | geraete-ca-pruefen | virenscan-pruefen | crowdsec-pruefen [ip]",
    );
    return 2;
  }
  loadConfig();
  const handle = await getDbHandle();
  const { db } = handle;
  try {
    if (cmd === "info") {
      const migrations = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`))[0]?.n ?? 0;
      const info = {
        version: process.env.SCHULOS_VERSION ?? "dev",
        instance: (await instanceTypeInDb(db)) ?? "leer",
        database: process.env.DATABASE_URL ? "postgres" : "pglite",
        migrations,
        accounts: await countByRole(db),
      };
      console.log(JSON.stringify(info));
    } else if (cmd === "probe") {
      const r = await probeSmoke(db, `http://127.0.0.1:${process.env.PORT ?? 3000}`);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    } else if (cmd === "schulprofil-export") {
      const files = process.env.FILES_DIR;
      console.log(JSON.stringify(await buildSchulprofil(db, files ? localStorage(files) : null, MODULES), null, 2));
    } else if (cmd === "schulprofil-import") {
      if (!args[0]) throw new OpsError("Aufruf: node cli.mjs schulprofil-import <datei>");
      const files = process.env.FILES_DIR;
      const r = await importSchulprofil(db, files ? localStorage(files) : null, MODULES, null, parseSchulprofil(readFileSync(args[0], "utf8")));
      console.log(JSON.stringify(r));
    } else if (cmd === "schulnetz-zuruecksetzen") {
      console.log((await resetSchoolNets(db)) ? "Schulnetz-Bereiche auf die Vorgabe zurückgesetzt." : "Es waren keine eigenen Schulnetz-Bereiche eingetragen.");
    } else if (cmd === "reset-admin") {
      const r = await resetAdmin(db, args[0]);
      console.error(`Admin-Konto „${r.username}“ zurückgesetzt: zweiter Faktor aus, Sperre aufgehoben, alle Sitzungen beendet.`);
      if (r.schoolNetsReset) console.error("Schulnetz-Bereiche auf die Vorgabe zurückgesetzt (Verwaltung → System → Anmeldung).");
      console.error("Neues Passwort (nur jetzt sichtbar, beim nächsten Anmelden zu ändern):");
      console.log(r.password);
    } else {
      // Dateien der Demo-Konten (Uploads) gehören zum Demo-Stand; demoReset leert den Speicher und legt das Demo-Logo neu an
      const files = process.env.FILES_DIR;
      const r = await demoReset(db, process.env, files ? localStorage(files) : undefined);
      console.log(`Demo-Schule neu eingespielt (${r.users} Konten)`);
      // P4-77: Vorschau mit Schulprofil – Zuschnitt der echten Schule nach jedem Zurücksetzen wieder einspielen
      const profilePath = process.env.SCHULOS_SCHULPROFIL || (process.env.SCHULOS_CONFIG_DIR ? join(process.env.SCHULOS_CONFIG_DIR, "schulprofil.json") : "");
      if (profilePath && existsSync(profilePath)) {
        const p = await importSchulprofil(db, files ? localStorage(files) : null, MODULES, null, parseSchulprofil(readFileSync(profilePath, "utf8")));
        console.log(`Schulprofil eingespielt (${p.modules} Module, ${p.settings} Einstellungen, ${p.grants} Rechte, ${p.logos} Logos, ${p.skipped.length} übersprungen)`);
      }
    }
    return 0;
  } catch (e) {
    console.error(e instanceof OpsError ? e.message : e instanceof ValidationError ? Object.values(e.fieldErrors).join(" ") : e);
    return 1;
  } finally {
    await handle.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
