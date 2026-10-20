// Eigenexport (B-04, DS-05, Art. 20 DSGVO): „Meine Dateien und Abgaben herunterladen“ – für alle, besonders vor
// dem Abgang. Anders als die Auskunft (B-03) lesbar gegliedert: Ordnerstruktur, Abgaben je Aufgabe, eigene Aufgaben.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { fileNodes, users } from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { toBerlinDate } from "@/core/time";
import { assertExportSize } from "@/core/export-limit";
import { createZipAsync, type ZipEntry } from "@/core/zip";
import { taskFiles, tasks, taskSubmissions } from "@/modules/aufgaben/schema";
import { schoolbookAuskunft, schoolbookText } from "@/modules/buecherei/ausgabe";
import { libraryAuskunft, libraryText } from "@/modules/buecherei/katalog";

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim().slice(0, 100) || "unbenannt";
const dtFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export interface OwnExportPlan {
  entries: { path: string; storageKey?: string; text?: string; size?: number }[];
  counts: { files: number; submissions: number; tasks: number };
  /** Summe der Dateigrößen laut Datenbank (Obergrenze, SEC-05) */
  bytes: number;
}

/** Rein lesend: was in den Eigenexport kommt (Pfade im ZIP, Dateischlüssel bzw. Text). */
export async function planOwnExport(db: Db, userId: string): Promise<OwnExportPlan> {
  const entries: OwnExportPlan["entries"] = [];
  const used = new Set<string>();
  const push = (path: string, e: { storageKey?: string; text?: string; size?: number }) => {
    let p = path;
    for (let i = 2; used.has(p.toLowerCase()); i++) p = path.replace(/(\.[^./]*)?$/, (ext) => ` (${i})${ext}`);
    used.add(p.toLowerCase());
    entries.push({ path: p, ...e });
  };

  // Meine Dateien: persönlicher Bereich mit Ordnerstruktur
  const nodes = await db
    .select({ id: fileNodes.id, kind: fileNodes.kind, name: fileNodes.name, parentId: fileNodes.parentId, storageKey: fileNodes.storageKey, size: fileNodes.size })
    .from(fileNodes)
    .where(eq(fileNodes.ownerId, userId))
    .orderBy(sql`${fileNodes.name} collate "C"`); // Bytefolge: nummerierte Dubletten unabhängig von der DB-Collation
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const folderPath = (id: string | null, depth = 0): string => {
    if (!id || depth > 50) return "";
    const n = byId.get(id);
    return n ? `${folderPath(n.parentId, depth + 1)}${safe(n.name)}/` : "";
  };
  let files = 0;
  for (const n of nodes)
    if (n.kind === "file" && n.storageKey) {
      push(`Meine Dateien/${folderPath(n.parentId)}${safe(n.name)}`, { storageKey: n.storageKey, size: n.size });
      files++;
    }

  // Abgaben (Schüler:innen): Text, Rückmeldung, Bewertung und hochgeladene Dateien
  const subs = await db
    .select({
      id: taskSubmissions.id,
      title: tasks.title,
      dueAt: tasks.dueAt,
      text: taskSubmissions.text,
      submittedAt: taskSubmissions.submittedAt,
      feedback: taskSubmissions.feedback,
      grade: taskSubmissions.grade,
      returnedAt: taskSubmissions.returnedAt,
    })
    .from(taskSubmissions)
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .where(eq(taskSubmissions.studentId, userId))
    .orderBy(asc(tasks.dueAt));
  for (const s of subs) {
    const dir = `Abgaben/${toBerlinDate(s.dueAt)} ${safe(s.title)}`;
    const lines = [`Aufgabe: ${s.title}`, `Abgegeben: ${dtFmt.format(s.submittedAt)}`, "", s.text?.trim() || "(kein Text)"];
    if (s.returnedAt || s.feedback || s.grade)
      lines.push("", "— Rückmeldung —", ...(s.grade ? [`Bewertung: ${s.grade}`] : []), s.feedback?.trim() || "(ohne Text)");
    push(`${dir}/abgabe.txt`, { text: lines.join("\n") + "\n" });
    for (const f of await db
      .select({ name: taskFiles.name, storageKey: taskFiles.storageKey, size: taskFiles.size })
      .from(taskFiles)
      .where(eq(taskFiles.submissionId, s.id))
      .orderBy(asc(taskFiles.name)))
      push(`${dir}/${safe(f.name)}`, { storageKey: f.storageKey, size: f.size });
  }

  // Eigene Aufgaben (Lehrkräfte): Aufgabentext und Material
  const own = await db
    .select({ id: tasks.id, title: tasks.title, description: tasks.description, dueAt: tasks.dueAt })
    .from(tasks)
    .where(eq(tasks.authorId, userId))
    .orderBy(asc(tasks.dueAt));
  for (const t of own) {
    const dir = `Meine Aufgaben/${toBerlinDate(t.dueAt)} ${safe(t.title)}`;
    push(`${dir}/aufgabe.md`, { text: `# ${t.title}\n\nFällig: ${dtFmt.format(t.dueAt)}\n\n${t.description}\n` });
    for (const f of await db
      .select({ name: taskFiles.name, storageKey: taskFiles.storageKey, size: taskFiles.size })
      .from(taskFiles)
      .where(and(eq(taskFiles.taskId, t.id), isNull(taskFiles.submissionId)))
      .orderBy(asc(taskFiles.name)))
      push(`${dir}/${safe(f.name)}`, { storageKey: f.storageKey, size: f.size });
  }
  // BU-03: Schulbücherei – nur der aktuelle Stand (offene Ausleihen, Befunde, Vormerkungen); einen Verlauf gibt es nicht
  const library = libraryText(await libraryAuskunft(db, userId));
  if (library) push("Bücherei.txt", { text: library });
  // BU-11: Schulbücher – offene und Rücknahmen mit Befund
  const schoolbooks = schoolbookText(await schoolbookAuskunft(db, userId));
  if (schoolbooks) push("Schulbücher.txt", { text: schoolbooks });
  const bytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  return { entries, counts: { files, submissions: subs.length, tasks: own.length }, bytes };
}

/**
 * Baut den Eigenexport als ZIP (nur ausgeliefert, nicht gespeichert; Audit-Eintrag ohne Inhalte). Zu große Exporte
 * (MAX_EXPORT_BYTES) brechen vor dem Lesen der Dateien ab; Dateien werden einzeln gelesen und im Thread-Pool komprimiert.
 */
export async function buildOwnExport(db: Db, storage: FileStorage, userId: string, now = new Date()): Promise<{ filename: string; zip: Uint8Array }> {
  const [u] = await db.select({ username: users.username, name: users.name }).from(users).where(eq(users.id, userId));
  const plan = await planOwnExport(db, userId);
  assertExportSize(plan.bytes);
  const enc = new TextEncoder();
  let missing = 0;
  async function* files(): AsyncGenerator<ZipEntry> {
    for (const e of plan.entries) {
      if (e.text !== undefined) {
        yield { name: e.path, data: enc.encode(e.text), modifiedAt: now };
        continue;
      }
      const stream = await storage.get(e.storageKey!);
      if (!stream) {
        missing++;
        continue;
      }
      yield { name: e.path, data: new Uint8Array(await new Response(stream).arrayBuffer()), modifiedAt: now };
    }
    const info = [
      `Meine Dateien und Abgaben – ${u?.name ?? ""}`,
      `Erstellt: ${dtFmt.format(now)}`,
      "",
      `Dateien: ${plan.counts.files} · Abgaben: ${plan.counts.submissions} · eigene Aufgaben: ${plan.counts.tasks}`,
      ...(missing ? ["", `Hinweis: ${missing} Datei(en) fehlten im Speicher.`] : []),
      "",
      "Alle gespeicherten Daten zu deinem Konto (Auskunft nach Art. 15 DSGVO) stellt dir die Schulverwaltung auf Anfrage zusammen.",
    ];
    yield { name: "LIESMICH.txt", data: enc.encode(info.join("\n") + "\n"), modifiedAt: now };
  }
  const zip = await createZipAsync(files());
  await audit(db, userId, "datenschutz.eigenexport", userId, plan.counts);
  return { filename: `meine-daten_${u?.username ?? "export"}_${toBerlinDate(now)}.zip`, zip };
}
