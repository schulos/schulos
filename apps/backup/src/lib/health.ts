/** Antwort von /api/health (Docker-Healthcheck, Ampel des Installers). */
export type Health = { ok: boolean; app: "schulos-backup"; version: string; db: "up" | "down" };

export function health(version: string, dbUp: boolean): Health {
  return { ok: dbUp, app: "schulos-backup", version, db: dbUp ? "up" : "down" };
}
