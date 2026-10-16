import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondFactorForm } from "@schulos/ui/auth-forms";
import { getCurrentUser } from "@/auth/session";
import { AuthCard, safeNext } from "../../auth-card";
import { verifySecondFactorAction } from "./actions";

export const metadata: Metadata = { title: "Zweiter Faktor" };
export const dynamic = "force-dynamic";

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <AuthCard title="Zweiter Faktor">
      <p className="mb-5 text-sm text-muted">Öffne deine Authenticator-App und gib den aktuellen Code für SchulOS Backup ein.</p>
      <SecondFactorForm action={verifySecondFactorAction} next={safeNext(next)} />
      <p className="mt-6 text-center text-xs text-muted">
        <Link href="/login" className="hover:underline">
          Abbrechen
        </Link>
      </p>
    </AuthCard>
  );
}
