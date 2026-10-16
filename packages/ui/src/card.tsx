import Link from "next/link";
import { cn } from "./cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <article
      className={cn("flex flex-col gap-4 rounded-card border border-border bg-surface p-5", className)}
      {...props}
    />
  );
}

/** Kartenkopf mit Titel und optionalem Link rechts („Alle Aufgaben"). */
export function CardHeader({
  title,
  action,
  className,
}: {
  title: React.ReactNode;
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <header className={cn("flex items-center justify-between gap-3", className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      {action && (
        <Link href={action.href} className="text-sm font-medium text-accent-ink hover:underline">
          {action.label}
        </Link>
      )}
    </header>
  );
}
