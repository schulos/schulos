import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-muted ring-1 ring-border ring-inset",
        accent: "bg-accent text-accent-fg",
        soft: "bg-accent-soft text-accent-ink",
        warn: "bg-warn-soft text-warn ring-1 ring-warn-border ring-inset",
        danger: "bg-danger-soft text-danger",
        success: "bg-success-soft text-success",
        count: "min-w-5 justify-center bg-ink text-surface",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
