/**
 * Passwortregeln (B-11, DATENSCHUTZ.md §5): Länge statt Zeichenklassen-Zwang (BSI/NIST), dazu bekannte und
 * naheliegende Passwörter ablehnen. Rein und offline – die Schule braucht keinen Zugriff auf externe Dienste.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Häufige Grundwörter; mit angehängten Ziffern/Zeichen („Passwort2026!“) ebenso abgelehnt. */
const COMMON_WORDS = [
  "passwort", "password", "kennwort", "geheim", "secret", "schule", "schulos", "iserv", "lehrer", "lehrerin", "schueler", "schüler",
  "hallo", "hello", "willkommen", "welcome", "admin", "administrator", "sommer", "winter", "herbst", "fruehling", "frühling",
  "qwertz", "qwerty", "asdfgh", "yxcvbn", "iloveyou", "ichliebedich", "schatz", "fussball", "fußball", "bayern", "schalke",
  "dortmund", "borussia", "football", "letmein", "monkey", "dragon", "master", "sunshine", "princess", "starwars", "pokemon",
  "minecraft", "test", "testtest", "abc", "abcdef", "start", "login", "changeme", "deutschland", "berlin", "hamburg",
];

/** Häufige vollständige Passwörter ab 10 Zeichen (Leaks), klein geschrieben. */
const COMMON_PASSWORDS = new Set([
  "1234567890", "0987654321", "1234554321", "1122334455", "1q2w3e4r5t", "1qaz2wsx3edc", "qwertyuiop", "qwertzuiop", "asdfghjkl1",
  "a1b2c3d4e5", "123456789a", "123qweasdzxc", "iloveyou12", "zaq12wsxcde", "q1w2e3r4t5", "passw0rd12", "trustno1234",
]);

const SEQUENCES = ["0123456789", "9876543210", "abcdefghijklmnopqrstuvwxyz", "qwertzuiopü", "qwertyuiop", "asdfghjklöä", "yxcvbnm", "zxcvbnm"];

export interface PasswordContext {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

function fold(s: string): string {
  return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

/** Fehlermeldung oder null. */
export function checkPassword(password: string, ctx: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN) return `Mindestens ${PASSWORD_MIN} Zeichen.`;
  if (password.length > PASSWORD_MAX) return `Höchstens ${PASSWORD_MAX} Zeichen.`;
  const p = fold(password);
  if (new Set(p).size <= 2) return "Zu wenige verschiedene Zeichen.";
  if (COMMON_PASSWORDS.has(p)) return "Dieses Passwort ist bekannt und wird oft ausprobiert.";
  // Grundwort + Ziffern/Zeichen (z. B. „Passwort2026!“, „Schule123456“)
  const base = p.replace(/[^a-z]+$/g, "").replace(/^[^a-z]+/g, "");
  if (COMMON_WORDS.map(fold).includes(base) || (base.length < 4 && /\d{4,}/.test(p))) return "Zu leicht zu erraten (bekanntes Wort mit Zahlen).";
  for (const seq of SEQUENCES) {
    const f = fold(seq);
    for (let i = 0; i + 6 <= f.length; i++) if (p.includes(f.slice(i, i + 6))) return "Keine Tastatur- oder Zahlenfolgen (z. B. „123456“, „qwertz“).";
  }
  for (const part of [ctx.username, ctx.firstName, ctx.lastName, ...(ctx.username?.split(/[._-]/) ?? [])]) {
    if (part && part.length >= 3 && p.includes(fold(part))) return "Das Passwort darf den eigenen Namen oder Benutzernamen nicht enthalten.";
  }
  return null;
}

/** Zufälliges, gut lesbares Startpasswort (ohne 0/O/l/1). */
export function generatePassword(length = 10): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export type PasswordFieldErrors = Partial<Record<"current" | "next" | "repeat", string>>;

/** Eingaben beim Passwortwechsel prüfen (vor dem Aufruf von Better-Auth) – Feldfehler oder null. */
export function validatePasswordChange(user: PasswordContext, input: { current: string; next: string; repeat: string }): PasswordFieldErrors | null {
  if (!input.current) return { current: "Bitte das bisherige Passwort eingeben." };
  const rule = checkPassword(input.next, user);
  if (rule) return { next: rule };
  if (input.next === input.current) return { next: "Das neue Passwort muss sich vom bisherigen unterscheiden." };
  if (input.next !== input.repeat) return { repeat: "Die Wiederholung stimmt nicht überein." };
  return null;
}
