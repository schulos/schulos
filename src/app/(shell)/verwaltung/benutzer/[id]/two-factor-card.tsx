"use client";

import { ListOrdered, Printer, ShieldOff, Unlock } from "lucide-react";
import { useState, useTransition } from "react";
import { resetTwoFactorAction, type FormState } from "@/modules/verwaltung/actions";
import { createCodeListAction, releaseExternalSetupAction, type TwoFactorAdminState } from "@/modules/verwaltung/zwei-faktor-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** SEC-02: Druckblatt in einem eigenen Fenster – die Codes stehen nirgends sonst (nur gehasht gespeichert). */
function printCodes(p: { name: string; className: string | null; school: string; codes: string[] }) {
  const w = window.open("", "_blank", "width=700,height=900");
  if (!w) return;
  const date = new Date().toLocaleDateString("de-DE");
  w.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Code-Liste ${esc(p.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2cm;color:#000}h1{font-size:20px;margin:0 0 4px}p{font-size:13px;line-height:1.5}
ol{font-family:ui-monospace,monospace;font-size:18px;line-height:2;columns:2}li{padding-left:6px}.box{border:1px solid #000;padding:12px;margin-top:16px}</style>
</head><body><h1>Code-Liste für die Anmeldung von außen</h1>
<p><strong>${esc(p.name)}</strong>${p.className ? ` · Klasse ${esc(p.className)}` : ""} · ${esc(p.school)} · erstellt am ${date}</p>
<ol>${p.codes.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
<div class="box"><p>Wenn du dich <strong>außerhalb der Schule</strong> bei SchulOS anmeldest, fragt SchulOS nach dem Passwort nach einem Code.
Nimm einen Code von dieser Liste und streiche ihn durch – jeder Code gilt nur einmal. In der Schule brauchst du keinen Code.</p>
<p>Bewahre die Liste sicher auf (nicht beim Passwort, nicht fotografieren). Verloren oder alle Codes benutzt? Das Sekretariat druckt eine neue Liste – die alte gilt dann nicht mehr.</p></div>
</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

export function TwoFactorCardBody({
  id,
  enabled,
  duty,
  isSelf,
  canManage = true,
  releasedUntil = null,
  releasable = true,
  codeList = null,
  student = null,
  methods = null,
}: {
  id: string;
  enabled: boolean;
  /** SEC-01: Text zur Pflicht dieses Kontos („Pflicht“, „Pflicht ab …“, „nur von außen“) oder null */
  duty: { label: string; strict: boolean } | null;
  isSelf: boolean;
  /** SEC-04/SEC-02: Recht `verwaltung.zwei_faktor` und das Konto darf von dieser Person verwaltet werden */
  canManage?: boolean;
  /** Q-5A-30: Einrichtung von außen freigegeben bis (Text) */
  releasedUntil?: string | null;
  /** Freigabe nötig/möglich (nicht für Eltern – die dürfen von außen einrichten) */
  releasable?: boolean;
  /** SEC-02: vorhandene Code-Liste */
  codeList?: { remaining: number; total: number; createdAt: string } | null;
  /** SEC-02: nur Schüler:innen bekommen Code-Listen – Angaben fürs Druckblatt */
  student?: { name: string; className: string | null; school: string } | null;
  /** SEC-03: eingerichtete Wege (Code-App, Anzahl Sicherheitsschlüssel) */
  methods?: { totp: boolean; passkeys: number } | null;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FormState>({});
  const [admin, setAdmin] = useState<TwoFactorAdminState>({});
  const active = enabled || (codeList?.remaining ?? 0) > 0;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={enabled ? "success" : duty?.strict ? "warn" : undefined}>{enabled ? "eingeschaltet" : "aus"}</Badge>
        {duty && <span className="text-muted">{duty.label}</span>}
      </p>
      {methods && enabled && (
        <p data-testid="zwei-faktor-wege">
          {[methods.totp ? "Code-App" : null, methods.passkeys ? `${methods.passkeys} Sicherheitsschlüssel` : null].filter(Boolean).join(" und ")}
        </p>
      )}
      {codeList && (
        <p data-testid="codeliste-status">
          Code-Liste vom {codeList.createdAt}: noch {codeList.remaining} von {codeList.total} Codes unbenutzt.
        </p>
      )}
      {active && !isSelf && canManage && (
        <>
          <p className="text-muted">
            Gerät verloren und keine Wiederherstellungscodes mehr? Zurücksetzen entfernt Code-App und Sicherheitsschlüssel, beendet alle Sitzungen und macht eine Code-Liste ungültig
            {duty?.strict ? "; bei der nächsten Anmeldung muss die Person 2FA neu einrichten." : "."} Die Person
            {student ? " und ihre Eltern bekommen" : " bekommt"} eine Mitteilung.
          </p>
          <div>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                if (confirm("Zwei-Faktor-Anmeldung zurücksetzen? Die Person wird abgemeldet.")) start(async () => setResult(await resetTwoFactorAction(id)));
              }}
            >
              <ShieldOff aria-hidden /> Zwei-Faktor zurücksetzen
            </Button>
          </div>
        </>
      )}
      {student && !isSelf && canManage && (
        <>
          <p className="text-muted">
            Ohne Handy: eine gedruckte Liste mit {10} Einmalcodes für die Anmeldung von außerhalb des Schulnetzes. Eine neue Liste macht die alte
            ungültig und meldet das Konto auf allen Geräten ab; die Codes sind nur jetzt sichtbar.
          </p>
          <div>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                if (!codeList || confirm("Neue Code-Liste erzeugen? Die bisherige Liste gilt dann nicht mehr, und alle Anmeldungen des Kontos enden.")) start(async () => setAdmin(await createCodeListAction(id)));
              }}
            >
              <ListOrdered aria-hidden /> {codeList ? "Neue Code-Liste erzeugen" : "Code-Liste erzeugen"}
            </Button>
          </div>
          {admin.codes && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3">
              <ol aria-label="Codes der Liste" className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono">
                {admin.codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
              <div>
                <Button variant="secondary" size="sm" onClick={() => printCodes({ ...student, codes: admin.codes! })}>
                  <Printer aria-hidden /> Drucken
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {!enabled && !isSelf && canManage && releasable && (
        <>
          <p className="text-muted">
            Zum ersten Mal einrichten geht nur im Schulnetz. Kann die Person nicht in die Schule kommen, gib die Einrichtung von außen für 48
            Stunden frei.
            {releasedUntil && ` Freigegeben bis ${releasedUntil}.`}
          </p>
          <div>
            <Button variant="secondary" disabled={pending} onClick={() => start(async () => setAdmin(await releaseExternalSetupAction(id)))}>
              <Unlock aria-hidden /> Einrichtung von außen freigeben
            </Button>
          </div>
        </>
      )}
      {result.ok && <p role="status">Zurückgesetzt.</p>}
      {admin.ok && <p role="status">{admin.ok}</p>}
      {(result.error ?? admin.error) && (
        <p role="alert" className="text-danger">
          {result.error ?? admin.error}
        </p>
      )}
    </div>
  );
}
