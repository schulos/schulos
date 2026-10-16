"use client";

import { useTransition } from "react";
import type { DemoAccount } from "@/core/auth/demo";
import { Avatar, initials } from "@schulos/ui/misc";
import { demoLoginAction } from "./demo-actions";

export function DemoPicker({ accounts }: { accounts: DemoAccount[] }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      {accounts.map((a) => (
        <button
          key={a.username}
          type="button"
          disabled={pending}
          onClick={() => start(() => demoLoginAction(a.username))}
          className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left transition hover:border-border-strong hover:bg-surface-2 disabled:opacity-60"
        >
          <Avatar label={initials(a.name)} tone="soft" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{a.name}</span>
            <span className="text-xs text-muted">{a.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
