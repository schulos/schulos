// Profilbilder nur mit Einwilligung (B-07, DS-09). Ohne Einwilligung zeigt SchulOS Initialen bzw. das Kürzel.
// Einwilligen dürfen: Lehrkräfte, Personal und Verwaltung für sich selbst, Eltern für ihr Kind, die Verwaltung bei schriftlicher
// Einwilligung (Formular, z. B. für volljährige Schüler:innen). Widerrufen dürfen zusätzlich Schüler:innen selbst.
// Hochgeladene Bilder verlieren ihre Metadaten (EXIF mit Aufnahmeort, Kamera, Datum).
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { cleanImage, type ImageRules } from "@/core/images";
import { parentChild, profilePhotos, users, type PHOTO_CONSENT_BASES } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { de } from "@/core/db/sort";

export type ConsentBasis = (typeof PHOTO_CONSENT_BASES)[number];
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const CONSENT_LABEL: Record<ConsentBasis, string> = {
  self: "selbst eingewilligt",
  parent: "Einwilligung der Eltern",
  paper: "schriftliche Einwilligung (Verwaltung)",
};

const SELF_ROLES = ["lehrkraft", "personal", "beratung", "verwaltung", "admin"];

/** Rein: auf welcher Grundlage darf `viewer` für `target` ein Foto mit Einwilligung hinterlegen? */
export function consentAuthority(viewer: PermissionSet, target: { id: string; role: string; selfResponsible?: boolean }, isParent: boolean): ConsentBasis | null {
  if (viewer.locked) return null;
  // Q5-05: eigenständige (volljährige) Schüler:innen willigen selbst ein – ihre Eltern nicht mehr
  if (viewer.userId === target.id && (SELF_ROLES.includes(target.role) || (target.role === "schueler" && target.selfResponsible))) return "self";
  if (isParent && target.role === "schueler" && !target.selfResponsible) return "parent";
  if (hasPermission(viewer, "verwaltung.users")) return "paper";
  return null;
}

/** Rein: Widerruf dürfen alle, die einwilligen dürften – und die Person selbst, auch als Schüler:in. */
export function canWithdraw(viewer: PermissionSet, target: { id: string; role: string; selfResponsible?: boolean }, isParent: boolean): boolean {
  return !viewer.locked && (viewer.userId === target.id || consentAuthority(viewer, target, isParent) !== null);
}

// ---------------------------------------------------------------- Bilddaten

/** Profilbilder: nur JPEG und PNG bis 2 MB, Metadaten fallen weg (Bild-Baustein src/core/images.ts). */
const PHOTO_RULES: ImageRules = {
  field: "photo",
  maxBytes: MAX_PHOTO_BYTES,
  types: ["image/jpeg", "image/png"],
  empty: "Bitte ein Foto auswählen",
  tooBig: "Das Foto ist zu groß (höchstens 2 MB)",
  wrongType: "Nur JPEG- oder PNG-Bilder",
};

/** Rein: prüft und bereinigt ein hochgeladenes Profilbild. */
export function cleanPhoto(bytes: Uint8Array): { data: Uint8Array; mime: "image/jpeg" | "image/png" } {
  const { data, mime } = cleanImage(bytes, PHOTO_RULES);
  return { data, mime: mime as "image/jpeg" | "image/png" };
}

// ---------------------------------------------------------------- Datenbank

export const photoUrl = (userId: string, version: Date | null | undefined): string | undefined =>
  version ? `/api/profilbild/${encodeURIComponent(userId)}?v=${version.getTime()}` : undefined;

async function loadTarget(db: Db, viewer: PermissionSet, targetId: string) {
  const [target] = await db.select({ id: users.id, role: users.role, name: users.name, selfResponsible: users.selfResponsible }).from(users).where(eq(users.id, targetId));
  if (!target) throw new ValidationError({ photo: "Person nicht gefunden" });
  const [link] = await db
    .select({ p: parentChild.parentId })
    .from(parentChild)
    .where(and(eq(parentChild.parentId, viewer.userId), eq(parentChild.childId, targetId)));
  return { target, isParent: Boolean(link) };
}

export async function photoOf(db: Db, userId: string) {
  const [row] = await db.select().from(profilePhotos).where(eq(profilePhotos.userId, userId));
  return row ?? null;
}

export interface PhotoInput {
  bytes: Uint8Array;
  consent: boolean;
  /** nur bei schriftlicher Einwilligung: Datum auf dem Formular */
  consentOn?: string;
}

/** Hinterlegt ein Foto mit Einwilligung (ersetzt ein vorhandenes). */
export async function setProfilePhoto(db: Db, storage: FileStorage, viewer: PermissionSet, targetId: string, input: PhotoInput, todayYmd: string) {
  const { target, isParent } = await loadTarget(db, viewer, targetId);
  const basis = consentAuthority(viewer, target, isParent);
  if (!basis) throw new ValidationError({ photo: "Für diese Person darf kein Profilbild hinterlegt werden" });
  if (!input.consent)
    throw new ValidationError({ consent: basis === "paper" ? "Bitte bestätigen, dass die schriftliche Einwilligung vorliegt" : "Bitte die Einwilligung bestätigen" });
  let consentOn = todayYmd;
  if (basis === "paper") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.consentOn ?? "") || input.consentOn! > todayYmd)
      throw new ValidationError({ consentOn: "Datum der Einwilligung angeben (nicht in der Zukunft)" });
    consentOn = input.consentOn!;
  }
  const { data, mime } = cleanPhoto(input.bytes);
  const key = newStorageKey();
  await storage.put(key, data);
  const old = await photoOf(db, targetId);
  await db
    .insert(profilePhotos)
    .values({ userId: targetId, storageKey: key, mime, consentBasis: basis, consentBy: viewer.userId, consentOn })
    .onConflictDoUpdate({
      target: profilePhotos.userId,
      set: { storageKey: key, mime, consentBasis: basis, consentBy: viewer.userId, consentOn, createdAt: new Date() },
    });
  if (old) await storage.delete(old.storageKey);
  await audit(db, viewer.userId, "profilbild.einwilligung", targetId, { basis, consentOn });
}

/** Widerruf: Foto und Einwilligung werden sofort gelöscht. */
export async function removeProfilePhoto(db: Db, storage: FileStorage, viewer: PermissionSet, targetId: string): Promise<boolean> {
  const { target, isParent } = await loadTarget(db, viewer, targetId);
  if (!canWithdraw(viewer, target, isParent)) throw new ValidationError({ photo: "Keine Berechtigung" });
  const old = await photoOf(db, targetId);
  if (!old) return false;
  await db.delete(profilePhotos).where(eq(profilePhotos.userId, targetId));
  await storage.delete(old.storageKey);
  await audit(db, viewer.userId, "profilbild.widerruf", targetId, {});
  return true;
}

/** Für die Seite „Profilbild“: eigene Person und – bei Eltern – die Kinder, jeweils mit Stand und Befugnis. */
export async function photoSubjects(db: Db, viewer: PermissionSet) {
  const kids =
    viewer.role === "eltern"
      ? await db
          .select({ id: users.id, name: users.name, role: users.role, selfResponsible: users.selfResponsible })
          .from(parentChild)
          .innerJoin(users, eq(users.id, parentChild.childId))
          // Q5-05: über das Foto eigenständiger Kinder entscheiden diese selbst
          .where(and(eq(parentChild.parentId, viewer.userId), eq(users.status, "active"), eq(users.selfResponsible, false)))
          .orderBy(de(users.name))
      : [];
  const [me] = await db.select({ id: users.id, name: users.name, role: users.role, selfResponsible: users.selfResponsible }).from(users).where(eq(users.id, viewer.userId));
  const people = [...(me && me.role !== "eltern" ? [{ ...me, isParent: false }] : []), ...kids.map((k) => ({ ...k, isParent: true }))];
  return Promise.all(
    people.map(async (p) => {
      const photo = await photoOf(db, p.id);
      const own = p.id === viewer.userId;
      // eigene Seite: Verwaltung willigt hier nur für sich selbst ein, nicht „schriftlich“ für sich
      const basis = consentAuthority(viewer, p, p.isParent);
      return {
        id: p.id,
        name: p.name,
        own,
        photo,
        url: photoUrl(p.id, photo?.createdAt),
        basis: basis === "paper" && own ? null : basis,
        canWithdraw: canWithdraw(viewer, p, p.isParent),
      };
    }),
  );
}
