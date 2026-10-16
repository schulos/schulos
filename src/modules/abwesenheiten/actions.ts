"use server";

import { revalidatePath } from "next/cache";
import { moduleActions } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { FormState } from "@/modules/verwaltung/actions";
import { ValidationError } from "@/modules/verwaltung/users";
import { decideLeave, requestLeave, withdrawLeave, type LeaveInput } from "./beurlaubung";
import { decideDay } from "./fehlzeiten";
import { decideReport, reportAbsence, type ReportInput } from "./service";

const { requireUser } = moduleActions("abwesenheiten");

export async function reportAbsenceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const input: ReportInput = { studentId: str("studentId"), fromDate: str("fromDate"), toDate: str("toDate"), reason: str("reason") as ReportInput["reason"] };
  try {
    await reportAbsence(await getDb(), perms, input, toBerlinDate(new Date()), { channel: form.get("channel") === "telefon" ? "telefon" : undefined });
  } catch (err) {
    if (err instanceof ValidationError) {
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: { ...input } };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function decideReportAction(id: string, excused: boolean): Promise<void> {
  const { perms } = await requireUser();
  await decideReport(await getDb(), perms, id, excused, toBerlinDate(new Date()));
  revalidatePath("/", "layout");
}

/** Q5-13: Klassenleitung entscheidet über einen Fehltag ohne Meldung. */
export async function decideDayAction(studentId: string, date: string, excused: boolean): Promise<void> {
  const { perms } = await requireUser();
  await decideDay(await getDb(), perms, studentId, date, excused, toBerlinDate(new Date()));
  revalidatePath("/", "layout");
}

/** Q5-16: Beurlaubung vorab beantragen (Eltern, volljährige Schüler:innen). */
export async function requestLeaveAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { perms } = await requireUser();
  const str = (k: string) => String(form.get(k) ?? "");
  const input: LeaveInput = { studentId: str("studentId"), fromDate: str("fromDate"), toDate: str("toDate"), reason: str("reason") as LeaveInput["reason"] };
  try {
    await requestLeave(await getDb(), perms, input, toBerlinDate(new Date()));
  } catch (err) {
    if (err instanceof ValidationError) {
      return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: { ...input } };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function decideLeaveAction(id: string, approve: boolean): Promise<void> {
  const { perms } = await requireUser();
  await decideLeave(await getDb(), perms, id, approve);
  revalidatePath("/", "layout");
}

export async function withdrawLeaveAction(id: string): Promise<void> {
  const { perms } = await requireUser();
  await withdrawLeave(await getDb(), perms, id);
  revalidatePath("/", "layout");
}
