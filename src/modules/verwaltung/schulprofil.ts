// Schulprofil (P4-77): Zuschnitt einer Schule als JSON – Schuldaten, Logos, eingeschaltete Module, Moduleinstellungen,
// Rechte der Rollen und der Inaktivitätsablauf. **Keine Personendaten:** keine Konten, Gruppen, Mitgliedschaften, Noten,
// Inhalte, Impressum/Datenschutztexte (enthalten Namen) und keine Schulnetz-Bereiche. Das erzwingt das Schema selbst:
// jedes Feld ist eine Aufzählung, ein Wahrheitswert, ein eng begrenzter Bezeichner, der Schulname oder ein Bild – unbekannte
// Schlüssel werden abgelehnt (`z.strictObject`). Einspielen nur in Demo-/Vorschau-Instanzen (Q-4E-27): die Vorschau zeigt die
// echte Schule mit Demo-Personen.
import { eq, isNotNull } from "drizzle-orm";
import * as z from "zod";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings, grants, type Role } from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { instanceTypeInDb } from "@/core/instance";
import { mailAvailable } from "@/core/mail";
import { isEnabled, loadModuleStates, setModuleEnabled } from "@/core/modules/registry";
import { readModuleSettings, writeModuleSetting } from "@/core/modules/settings";
import type { ModuleManifest } from "@/core/modules/types";
import { IDLE_OPTIONS } from "@/core/auth/sitzungen";
import { formInfo, SCHOOL_FORMS, STATES } from "@/core/school/catalog";
import { prepareLogo, readLogos, setSchoolLogo } from "@/core/school/logo";
import { LOGO_VARIANTS, type LogoVariant } from "@/core/school/logo-meta";
import { readSchoolSettings, readSecuritySettings, SECURITY_KEYS } from "@/core/settings";
import { actorHas, assertMayGrant, loadActor } from "./escalation";
import { GRANTABLE_ROLES, grantablePermissions, roleGrantBlocked } from "./rights";
import { ValidationError } from "./users";

export const SCHULPROFIL_FORMAT = "schulos-schulprofil";
export const SCHULPROFIL_VERSION = 1;
/** größte Profildatei (Logos als Base64 eingerechnet: 1 + 1 + 0,5 MB → ~3,4 MB) */
export const SCHULPROFIL_MAX_BYTES = 4 * 1024 * 1024;

/** Bezeichner (Modul-IDs, Einstellungsschlüssel, Rechte, Optionswerte) – keine Leerzeichen, kein Freitext. */
const IDENT = /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z0-9_*]+)*)$/;
const ident = z.string().max(80).regex(IDENT);
const optionValue = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const logoSchema = z.strictObject({
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  /** Bilddatei als Base64 – beim Einspielen wie ein Upload geprüft (Typ, Größe, Metadaten entfernt) */
  data: z.string().max(1_500_000).regex(BASE64),
});

export const schulprofilSchema = z.strictObject({
  format: z.literal(SCHULPROFIL_FORMAT),
  version: z.literal(SCHULPROFIL_VERSION),
  exportedAt: z.iso.datetime(),
  schulosVersion: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9.+_-]+$/),
  school: z.strictObject({
    name: z.string().trim().min(1).max(120),
    number: z
      .string()
      .max(12)
      .regex(/^[0-9A-Za-z-]*$/),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    state: z.enum(STATES.map((s) => s.code) as [string, ...string[]]),
    form: z.enum(SCHOOL_FORMS),
    oberstufe: z.boolean(),
    abitur: z.enum(["g8", "g9"]),
  }),
  logos: z.strictObject({ logo: logoSchema.optional(), dark: logoSchema.optional(), symbol: logoSchema.optional() }),
  modules: z.record(ident, z.boolean()),
  moduleSettings: z.record(ident, optionValue),
  roleGrants: z.strictObject(
    Object.fromEntries(GRANTABLE_ROLES.map((r) => [r, z.array(ident).max(500)])) as Record<Exclude<Role, "admin">, z.ZodArray<typeof ident>>,
  ),
  security: z.strictObject({
    idleMinutes: z
      .number()
      .int()
      .refine((n) => (IDLE_OPTIONS as readonly number[]).includes(n)),
  }),
});

export type Schulprofil = z.infer<typeof schulprofilSchema>;

async function readStream(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Profil der Schule zusammenstellen (Export). Rechte prüft der Aufrufer; das Protokoll schreibt `exportSchulprofil`. */
export async function buildSchulprofil(db: Db, storage: FileStorage | null, manifests: readonly ModuleManifest[], now = new Date()): Promise<Schulprofil> {
  const [school, logos, states, security, roleRows] = await Promise.all([
    readSchoolSettings(db),
    readLogos(db),
    loadModuleStates(db),
    readSecuritySettings(db),
    db.select({ role: grants.role, permission: grants.permission }).from(grants).where(isNotNull(grants.role)),
  ]);
  const decls = manifests.flatMap((m) => m.settings ?? []);
  const settings = await readModuleSettings(db, decls);
  const outLogos: Schulprofil["logos"] = {};
  if (storage) {
    for (const v of LOGO_VARIANTS) {
      const meta = logos[v];
      const stream = meta ? await storage.get(meta.key) : null;
      if (meta && stream) outLogos[v] = { mime: meta.mime, data: Buffer.from(await readStream(stream)).toString("base64") };
    }
  }
  const roleGrants = Object.fromEntries(
    GRANTABLE_ROLES.map((r) => [
      r,
      roleRows
        .filter((g) => g.role === r)
        .map((g) => g.permission)
        .sort(),
    ]),
  ) as Schulprofil["roleGrants"];
  const profile: Schulprofil = {
    format: SCHULPROFIL_FORMAT,
    version: SCHULPROFIL_VERSION,
    exportedAt: now.toISOString(),
    schulosVersion: (process.env.SCHULOS_VERSION ?? "dev").replace(/[^A-Za-z0-9.+_-]/g, "").slice(0, 40) || "dev",
    school: { name: school.name, number: school.number, color: school.color, ...school.profile },
    logos: outLogos,
    modules: Object.fromEntries(manifests.filter((m) => !m.core).map((m) => [m.id, isEnabled(m, states)])),
    moduleSettings: Object.fromEntries(decls.map((d) => [d.key, settings.get(d.key) ?? d.default])),
    roleGrants,
    security: { idleMinutes: security.idleMinutes },
  };
  // das eigene Schema muss das Ergebnis annehmen – sonst ist hier etwas hineingeraten, das nicht hineingehört
  return schulprofilSchema.parse(profile);
}

/** Export mit Protokoll (ohne Inhalt – nur dass exportiert wurde). */
export async function exportSchulprofil(db: Db, storage: FileStorage | null, manifests: readonly ModuleManifest[], actorId: string, now = new Date()) {
  const p = await buildSchulprofil(db, storage, manifests, now);
  await audit(db, actorId, "verwaltung.schulprofil.export", null, { module: Object.keys(p.modules).length, logos: Object.keys(p.logos).length });
  return p;
}

/** Text bzw. Objekt prüfen; Fehler als ValidationError mit verständlicher Meldung (erster Befund). */
export function parseSchulprofil(input: string | unknown): Schulprofil {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.length > SCHULPROFIL_MAX_BYTES) throw new ValidationError({ file: "Die Datei ist zu groß für ein Schulprofil." });
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ValidationError({ file: "Die Datei ist kein gültiges JSON." });
    }
  }
  const r = schulprofilSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const where = issue.path.join(".") || "Datei";
    const msg = issue.code === "unrecognized_keys" ? `nicht erlaubte Angabe(n): ${issue.keys.join(", ")}` : issue.message;
    throw new ValidationError({ file: `Kein gültiges Schulprofil (${where}: ${msg}).` });
  }
  return r.data;
}

export interface ImportReport {
  modules: number;
  settings: number;
  grants: number;
  logos: number;
  /** übersprungene Angaben mit Grund (unbekannte Module/Rechte/Einstellungen, gesperrte Rechte) */
  skipped: string[];
}

/**
 * Profil einspielen (nur Demo-/Vorschau-Instanz). Schuldaten, Logos, Module, Moduleinstellungen, Rechte der Rollen (die
 * Rollen-Rechte werden ersetzt, Gruppenrechte bleiben) und Inaktivitätsablauf. Unbekanntes wird übersprungen und gemeldet.
 * `actorId` null = Kommandozeile (wie ein Admin).
 *
 * GATE-4e: Es gelten dieselben Regeln wie beim Ändern in der Oberfläche (G4E-C11/S04, Q-4E-45) – Einstellungen mit eigenem Recht
 * (z. B. Löschfristen, `verwaltung.privacy`) nur mit diesem Recht, Module mit Mailversand nur mit Mailversand, Rechte nur, soweit
 * der Handelnde sie vergeben dürfte (SEC-04). Die **eigene Rolle** bleibt unverändert (vergeben darf daran nur ein Admin –
 * ersetzen hieße sonst: alles entziehen), und Rechte, die der Handelnde nicht vergeben darf, bleiben bei der Rolle stehen.
 * Alle Datenbank-Änderungen in **einer** Transaktion (G4E-C03): scheitert ein Schritt, bleibt der alte Zuschnitt vollständig;
 * Logos (Dateispeicher) und Nachberechnungen der Einstellungen (`onChange`) erst nach dem Commit.
 */
export async function importSchulprofil(
  db: Db,
  storage: FileStorage | null,
  manifests: readonly ModuleManifest[],
  actorId: string | null,
  profile: Schulprofil,
  opts: { mail?: boolean } = {},
): Promise<ImportReport> {
  if ((await instanceTypeInDb(db)) !== "demo")
    throw new ValidationError({ file: "Ein Schulprofil lässt sich nur in eine Demo- bzw. Vorschau-Instanz einspielen – nie in die echte Schule." });
  const p = schulprofilSchema.parse(profile);
  const report: ImportReport = { modules: 0, settings: 0, grants: 0, logos: 0, skipped: [] };
  const actor = await loadActor(db, actorId);

  // ---- vorbereiten (nur lesen und prüfen) ----
  // Schuldaten (vom Schema geprüft); Oberstufe wie in saveSchoolSettings an die Schulform gebunden
  const fi = formInfo(p.school.form);
  const school: Record<string, unknown> = {
    "school.name": p.school.name,
    "school.number": p.school.number,
    "school.color": p.school.color.toUpperCase(),
    "school.state": p.school.state,
    "school.form": p.school.form,
    "school.oberstufe": fi.oberstufe === "immer" ? true : fi.oberstufe === "nie" ? false : p.school.oberstufe,
    "school.abitur": p.school.abitur,
  };

  // Logos wie ein Upload prüfen – geschrieben werden sie erst nach dem Commit
  const logos: { variant: LogoVariant; bytes: Uint8Array }[] = [];
  if (storage) {
    for (const v of LOGO_VARIANTS as readonly LogoVariant[]) {
      const logo = p.logos[v];
      if (!logo) continue;
      const bytes = new Uint8Array(Buffer.from(logo.data, "base64"));
      try {
        prepareLogo(bytes, v);
        logos.push({ variant: v, bytes });
      } catch (e) {
        report.skipped.push(`Logo „${v}“: ${e instanceof ValidationError ? Object.values(e.fieldErrors)[0] : "nicht lesbar"}`);
      }
    }
  }

  const mail = opts.mail ?? mailAvailable();
  const modules: { m: ModuleManifest; enabled: boolean }[] = [];
  for (const [id, enabled] of Object.entries(p.modules)) {
    const m = manifests.find((x) => x.id === id);
    if (!m) report.skipped.push(`Modul „${id}“: unbekannt`);
    else if (m.core) continue;
    // wie toggleModule (P4-33): Module mit Mailversand nur mit SMTP
    else if (enabled && m.needsMail && !mail) report.skipped.push(`Modul „${id}“: braucht den E-Mail-Versand`);
    else modules.push({ m, enabled });
  }

  const decls = manifests.flatMap((m) => m.settings ?? []);
  const settings: { decl: (typeof decls)[number]; value: string }[] = [];
  for (const [key, value] of Object.entries(p.moduleSettings)) {
    const decl = decls.find((d) => d.key === key);
    if (!decl) report.skipped.push(`Einstellung „${key}“: unbekannt`);
    else if (!decl.options.some((o) => o.value === value)) report.skipped.push(`Einstellung „${key}“: Wert „${value}“ gibt es hier nicht`);
    // wie setModuleSetting (DS-15): Einstellungen mit eigenem Recht nur mit diesem Recht
    else if (decl.permission && !actorHas(actor, decl.permission)) report.skipped.push(`Einstellung „${key}“: darfst du selbst nicht ändern`);
    else settings.push({ decl, value });
  }
  const before = await readModuleSettings(
    db,
    settings.map((s) => s.decl),
  );

  const known = new Set(grantablePermissions(manifests).map((x) => x.id));
  const mayGrant = (permission: string, role: Role) => {
    try {
      assertMayGrant(actor, permission, { role });
      return true;
    } catch {
      return false;
    }
  };
  const existing = await db.select({ role: grants.role, permission: grants.permission }).from(grants).where(isNotNull(grants.role));
  const roleGrants: { role: Role; permissions: string[] }[] = [];
  for (const role of GRANTABLE_ROLES) {
    const wanted = p.roleGrants[role as Exclude<Role, "admin">];
    // SEC-04: an die eigene Rolle vergibt nur ein Admin – ersetzen würde ihr hier alles entziehen
    if (!actor.isAdmin && role === actor.role) {
      if (wanted.length) report.skipped.push(`Rechte der Rolle „${role}“: deine eigene Rolle bleibt unverändert (ändern kann sie nur ein Admin)`);
      continue;
    }
    const next = new Set<string>();
    for (const permission of wanted) {
      if (!known.has(permission)) {
        report.skipped.push(`Recht „${permission}“ (${role}): unbekannt`);
        continue;
      }
      const blocked = roleGrantBlocked(role, permission);
      if (blocked) {
        report.skipped.push(`Recht „${permission}“ (${role}): ${blocked}`);
        continue;
      }
      if (!mayGrant(permission, role)) {
        report.skipped.push(`Recht „${permission}“ (${role}): darfst du selbst nicht vergeben`);
        continue;
      }
      next.add(permission);
    }
    // was der Handelnde nicht vergeben dürfte, nimmt er der Rolle auch nicht
    for (const g of existing) if (g.role === role && !mayGrant(g.permission, role)) next.add(g.permission);
    roleGrants.push({ role, permissions: [...next] });
  }

  // ---- schreiben: alles oder nichts ----
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(school))
      await tx
        .insert(appSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    for (const { m, enabled } of modules) await setModuleEnabled(tx, m, enabled);
    for (const { decl, value } of settings) await writeModuleSetting(tx, decl, value);
    for (const { role, permissions } of roleGrants) {
      await tx.delete(grants).where(eq(grants.role, role));
      for (const permission of permissions) await tx.insert(grants).values({ permission, role }).onConflictDoNothing();
    }
    await tx
      .insert(appSettings)
      .values({ key: SECURITY_KEYS.idleMinutes, value: p.security.idleMinutes })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: p.security.idleMinutes, updatedAt: new Date() } });
  });
  report.modules = modules.length;
  report.settings = settings.length;
  report.grants = roleGrants.reduce((n, r) => n + r.permissions.length, 0);

  // ---- nach dem Commit: Nachberechnungen und Dateispeicher ----
  for (const { decl, value } of settings) {
    if (!decl.onChange || before.get(decl.key) === value) continue;
    try {
      await decl.onChange(db);
    } catch {
      report.skipped.push(`Einstellung „${decl.key}“: gespeichert, aber die Nachberechnung ist fehlgeschlagen – bitte einmal von Hand speichern`);
    }
  }
  if (storage) {
    for (const { variant, bytes } of logos) {
      try {
        await setSchoolLogo(db, storage, actorId, variant, bytes);
        report.logos++;
      } catch (e) {
        report.skipped.push(`Logo „${variant}“: ${e instanceof ValidationError ? Object.values(e.fieldErrors)[0] : "nicht lesbar"}`);
      }
    }
  }

  if (actorId)
    await audit(db, actorId, "verwaltung.schulprofil.import", null, {
      module: report.modules,
      einstellungen: report.settings,
      rechte: report.grants,
      logos: report.logos,
      uebersprungen: report.skipped.length,
    });
  return report;
}

/** Nur zum Test: Schlüssel eines Profils rekursiv (Prüfung „keine Personenfelder“). */
export function profileKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [`${prefix}${k}`, ...(Array.isArray(v) ? [] : profileKeys(v, `${prefix}${k}.`))]);
}
