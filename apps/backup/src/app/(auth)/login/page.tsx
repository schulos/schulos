import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@schulos/ui/auth-forms";
import { getCurrentUser } from "@/auth/session";
import { AuthCard, safeNext } from "../auth-card";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Anmelden" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <AuthCard title="SchulOS Backup" subtitle="Backupserver">
      <LoginForm action={loginAction} next={safeNext(next)} />
    </AuthCard>
  );
}
