"use client";

import { useTransition } from "react";
import { dismissReportAction } from "@/modules/foren/actions";
import { Button } from "@schulos/ui/button";

export function DismissReport({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(() => dismissReportAction(id))}>
      Verwerfen
    </Button>
  );
}
