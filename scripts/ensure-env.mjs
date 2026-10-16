// Legt beim ersten Start eine .env.local mit zufälligem Auth-Secret an (gitignored).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const file = ".env.local";
const current = existsSync(file) ? readFileSync(file, "utf8") : "";
if (!/^BETTER_AUTH_SECRET=/m.test(current)) {
  const line = `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\n`;
  if (current) appendFileSync(file, (current.endsWith("\n") ? "" : "\n") + line);
  else writeFileSync(file, "# Lokal erzeugt von scripts/ensure-env.mjs – nicht committen\n" + line);
  console.log("[ensure-env] BETTER_AUTH_SECRET in .env.local angelegt");
}
