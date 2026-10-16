import { Badge } from "@schulos/ui/badge";
import { STATUS_LABELS, type TaskStatus } from "./service";

const TONES: Record<TaskStatus, "neutral" | "danger" | "success" | "warn" | "soft"> = {
  offen: "neutral",
  fehlt: "danger",
  abgegeben: "success",
  verspaetet: "warn",
  zurueckgegeben: "soft",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const fmtDue = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const rel = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });

/** „Mi., 7.10., 23:59 · in 2 Tagen" */
export function dueText(due: Date, now = new Date()): string {
  const diffH = (due.getTime() - now.getTime()) / 3_600_000;
  const relative = Math.abs(diffH) < 24 ? rel.format(Math.round(diffH), "hour") : rel.format(Math.round(diffH / 24), "day");
  return `${fmtDue.format(due)} · ${relative}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
}
