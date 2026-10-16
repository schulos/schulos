"use client";

import { useState, useTransition } from "react";
import { Button } from "@schulos/ui/button";
import { setParentsInformedAction, type ParentsInformedState } from "./actions";

export function ParentsInformedForm({ on }: { on: boolean }) {
  const [state, setState] = useState<ParentsInformedState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant={on ? "secondary" : "primary"}
        className="w-fit"
        disabled={pending}
        onClick={() => start(async () => setState(await setParentsInformedAction(!on)))}
      >
        {on ? "Einwilligung widerrufen" : "Eltern weiter informieren"}
      </Button>
      {state.ok && (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}
