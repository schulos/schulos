// CSV-Import von Schüler:innen: parsen → planen (Vorschau) → ausführen.
import { hashPassword } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { accounts, groupMembers, groups, users } from "@/core/db/schema";
import { normalizeEmail, placeholderEmail } from "@/core/auth/email";
import { splitCsvLine } from "@/core/csv";
import { toUsername } from "@/core/seed/rng";
import { generatePassword } from "@schulos/server/passwort";

export interface CsvRow {
  line: number;
  firstName: string;
  lastName: string;
  klasse: string;
  username?: string;
  /** optional, nur mit Kopfzeile „E-Mail“ (Q5-04) – bei Schüler:innen per Vorgabe leer */
  email?: string;
  /** optional, nur mit Kopfzeile „Eigenständig“/„Volljährig“ (Q5-05): ja/x/1 → eigenständig */
  selfResponsible?: boolean;
}

/** Q5-05: Werte, die in der Spalte „Eigenständig“ als ja gelten */
const YES = new Set(["ja", "j", "x", "1", "true", "yes", "y"]);

const HEADER_ALIASES: Record<string, keyof Omit<CsvRow, "line">> = {
  vorname: "firstName",
  nachname: "lastName",
  name: "lastName",
  klasse: "klasse",
  benutzername: "username",
  username: "username",
  "e-mail": "email",
  email: "email",
  mail: "email",
  "eigenständig": "selfResponsible",
  eigenstaendig: "selfResponsible",
  "volljährig": "selfResponsible",
  volljaehrig: "selfResponsible",
};

/**
 * Erwartet Spalten Vorname; Nachname; Klasse [; Benutzername] – mit oder ohne Kopfzeile,
 * Trennzeichen ; oder , (automatisch erkannt), UTF-8 mit/ohne BOM.
 */
export function parseStudentCsv(text: string): { rows: CsvRow[]; errors: { line: number; message: string }[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim()) ?? "";
  const sep = (firstNonEmpty.match(/;/g)?.length ?? 0) >= (firstNonEmpty.match(/,/g)?.length ?? 0) ? ";" : ",";

  let columns: (keyof Omit<CsvRow, "line">)[] = ["firstName", "lastName", "klasse", "username"];
  const rows: CsvRow[] = [];
  const errors: { line: number; message: string }[] = [];
  let headerSeen = false;

  lines.forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw.trim()) return;
    const cells = splitCsvLine(raw, sep);
    if (!headerSeen) {
      headerSeen = true;
      const mapped = cells.map((c) => HEADER_ALIASES[c.toLowerCase()]);
      if (mapped.filter(Boolean).length >= 2) {
        columns = mapped.map((m, i) => m ?? (`ignore${i}` as never));
        return;
      }
    }
    const rec: Record<string, string> = {};
    columns.forEach((col, i) => (rec[col] = cells[i] ?? ""));
    if (!rec.firstName || !rec.lastName || !rec.klasse) {
      errors.push({ line, message: "Vorname, Nachname und Klasse sind Pflicht" });
      return;
    }
    rows.push({
      line,
      firstName: rec.firstName,
      lastName: rec.lastName,
      klasse: rec.klasse,
      username: rec.username || undefined,
      email: rec.email?.trim() || undefined,
      ...(rec.selfResponsible && YES.has(rec.selfResponsible.trim().toLowerCase()) ? { selfResponsible: true } : {}),
    });
  });
  return { rows, errors };
}

export interface PlannedRow extends CsvRow {
  groupId?: string;
  groupName?: string;
  username: string;
  error?: string;
}

/** Vorschau: Klassen auflösen, Benutzernamen vergeben (eindeutig in DB UND Datei), Fehler markieren. */
export async function planImport(db: Db, rows: CsvRow[]): Promise<PlannedRow[]> {
  const classRows = await db.select({ id: groups.id, slug: groups.slug, name: groups.name }).from(groups).where(eq(groups.kind, "klasse"));
  const bySlug = new Map(classRows.map((c) => [c.slug.toLowerCase(), c]));

  const wanted = rows.map((r) => (r.username ?? toUsername(r.firstName, r.lastName)).toLowerCase());
  const bases = [...new Set(wanted)];
  const existing = new Set<string>();
  if (bases.length) {
    // alle vorhandenen Namen holen, die mit einem der Wunschnamen beginnen
    const all = await db.select({ u: users.username }).from(users);
    for (const { u } of all) if (u && bases.some((b) => u.startsWith(b))) existing.add(u);
  }
  const taken = new Set(existing);
  // E-Mail (Q5-04): gültig, nicht schon an einem Konto, nicht doppelt in der Datei
  const emails = rows.map((r) => normalizeEmail(r.email));
  const wantedMails = emails.flatMap((e) => (e.email ? [e.email] : []));
  const takenMails = new Set(
    wantedMails.length ? (await db.select({ e: users.email }).from(users).where(inArray(users.email, wantedMails))).map((r) => r.e) : [],
  );

  return rows.map((r, i) => {
    const klasse = bySlug.get(r.klasse.toLowerCase().replace(/^klasse\s*/, ""));
    let username = wanted[i]!;
    let error: string | undefined;
    if (!klasse) error = `Klasse „${r.klasse}“ gibt es nicht`;
    if (r.username) {
      if (!/^[a-z0-9._]{3,30}$/.test(username)) error ??= "Ungültiger Benutzername";
      else if (taken.has(username)) error ??= `Benutzername „${username}“ ist vergeben`;
    } else {
      const base = username || "schueler";
      username = base;
      for (let n = 2; taken.has(username); n++) username = `${base}${n}`;
    }
    const mail = emails[i]!;
    if (mail.error) error ??= `E-Mail: ${mail.error}`;
    else if (mail.email && takenMails.has(mail.email)) error ??= `E-Mail „${mail.email}“ hat schon ein Konto`;
    if (!error) {
      taken.add(username);
      if (mail.email) takenMails.add(mail.email);
    }
    return { ...r, email: mail.email ?? undefined, username, groupId: klasse?.id, groupName: klasse?.name, error };
  });
}

export interface ImportResult {
  created: { name: string; klasse: string; username: string; password: string }[];
  skipped: number;
}

/** Legt alle fehlerfreien Zeilen an (in einer Transaktion) und gibt die Startpasswörter zurück. */
export async function executeImport(db: Db, actorId: string, plan: PlannedRow[]): Promise<ImportResult> {
  const ok = plan.filter((p) => !p.error && p.groupId);
  // Erneut prüfen: zwischen Vorschau und Import könnte jemand Namen belegt haben.
  const clash = ok.length
    ? await db.select({ u: users.username }).from(users).where(inArray(users.username, ok.map((p) => p.username)))
    : [];
  if (clash.length) throw new Error(`Benutzernamen inzwischen vergeben: ${clash.map((c) => c.u).join(", ")} – bitte Vorschau neu laden`);

  const prepared = await Promise.all(
    ok.map(async (p) => {
      const password = generatePassword();
      return { p, password, hash: await hashPassword(password) };
    }),
  );
  await db.transaction(async (tx) => {
    for (const { p, hash } of prepared) {
      const id = `u-${p.username}`;
      await tx.insert(users).values({
        id,
        name: `${p.firstName} ${p.lastName}`,
        firstName: p.firstName,
        lastName: p.lastName,
        username: p.username,
        displayUsername: p.username,
        email: p.email ?? placeholderEmail(p.username),
        role: "schueler",
        selfResponsible: p.selfResponsible ?? false,
        mustChangePassword: true,
      });
      await tx.insert(accounts).values({ id: `acc-${id}`, accountId: id, providerId: "credential", userId: id, password: hash });
      await tx.insert(groupMembers).values({ groupId: p.groupId!, userId: id });
    }
  });
  await audit(db, actorId, "verwaltung.import.students", null, { count: ok.length, eigenstaendig: ok.filter((p) => p.selfResponsible).length });
  return {
    created: prepared.map(({ p, password }) => ({ name: `${p.firstName} ${p.lastName}`, klasse: p.groupName ?? p.klasse, username: p.username, password })),
    skipped: plan.length - ok.length,
  };
}

/** Zugangsdaten als CSV (Semikolon, mit BOM für Excel). */
export function credentialsCsv(created: ImportResult["created"]): string {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["Name;Klasse;Benutzername;Startpasswort", ...created.map((c) => [c.name, c.klasse, c.username, c.password].map(esc).join(";"))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
