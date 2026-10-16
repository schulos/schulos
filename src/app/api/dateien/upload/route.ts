import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { getStorage } from "@/core/files/storage";
import { moduleOffResponse } from "@/core/modules/guard";
import { MAX_FILE_BYTES, uploadFile } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

/** Formular-Overhead über der Dateigröße (Feldnamen, Grenzen) */
const MULTIPART_SLACK = 1024 * 1024;

/**
 * Multipart-Upload: Felder `space`, `parent` (optional), `files` (mehrfach; die Dateiablage schickt je Datei eine Anfrage).
 * Nur mit eingeschaltetem Modul – nur die Dateiablage selbst lädt hier hoch (SEC-05).
 */
export async function POST(req: Request) {
  const off = await moduleOffResponse("dateien");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  // Der Proxy puffert Bodies nur bis proxyClientMaxBodySize (next.config.ts) und schneidet den Rest still ab – größere
  // Anfragen gleich ablehnen statt mit einem abgeschnittenen Formular zu arbeiten.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + MULTIPART_SLACK)
    return Response.json({ error: "Die Datei ist größer als 25 MB" }, { status: 413 });
  const form = await req.formData();
  const space = String(form.get("space") ?? "personal");
  const parent = String(form.get("parent") ?? "") || null;
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "Keine Datei" }, { status: 400 });

  const db = await getDb();
  const perms = me.perms;
  const uploaded: { id: string; name: string }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      uploaded.push(await uploadFile(db, getStorage(), perms, space, parent, { name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) }));
    } catch (err) {
      if (err instanceof ValidationError) errors.push(Object.values(err.fieldErrors)[0] ?? "Fehler");
      else throw err;
    }
  }
  return Response.json({ uploaded, errors }, { status: uploaded.length ? 200 : 400 });
}
