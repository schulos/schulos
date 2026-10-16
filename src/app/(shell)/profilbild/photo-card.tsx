import { TZ, fromBerlinLocal } from "@/core/time";
import { removePhotoAction, setPhotoAction } from "@/core/privacy/profilbild-actions";
import { CONSENT_LABEL, type ConsentBasis } from "@/core/privacy/profilbild";
import { Button } from "@schulos/ui/button";
import { Avatar, initials } from "@schulos/ui/misc";
import { PhotoForm } from "./photo-form";

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

export interface PhotoCardProps {
  id: string;
  name: string;
  own: boolean;
  photo: { consentBasis: ConsentBasis; consentOn: string } | null;
  url?: string;
  basis: ConsentBasis | null;
  canWithdraw: boolean;
  today: string;
}

function consentText(basis: ConsentBasis, name: string): string {
  switch (basis) {
    case "self":
      return "Ich willige ein, dass mein Foto in SchulOS neben meinem Namen angezeigt wird (Adressbuch, Messenger, Menü). Die Einwilligung ist freiwillig und jederzeit hier widerrufbar.";
    case "parent":
      return `Ich bin erziehungsberechtigt und willige ein, dass das Foto von ${name} in SchulOS neben dem Namen angezeigt wird. Die Einwilligung ist freiwillig und jederzeit hier widerrufbar.`;
    case "paper":
      return `Die schriftliche Einwilligung für ${name} liegt vor und ist abgelegt.`;
  }
}

/** Profilbild einer Person: Stand der Einwilligung, Widerruf, Foto hinterlegen. */
export function PhotoCardBody({ id, name, own, photo, url, basis, canWithdraw, today }: PhotoCardProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar label={initials(name)} src={url} tone="soft" className="size-20 rounded-2xl text-xl" />
        <div className="flex flex-col gap-1 text-sm">
          {photo ? (
            <>
              <span className="font-medium">Profilbild wird angezeigt</span>
              <span className="text-muted">
                {CONSENT_LABEL[photo.consentBasis]} am {dateFmt.format(fromBerlinLocal(photo.consentOn))}
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">Kein Profilbild</span>
              <span className="text-muted">Ohne Einwilligung zeigt SchulOS die Initialen.</span>
            </>
          )}
        </div>
      </div>
      {photo && canWithdraw && (
        <form action={removePhotoAction}>
          <input type="hidden" name="userId" value={id} />
          <Button type="submit" variant="danger" aria-label={`Einwilligung für ${name} widerrufen`}>
            Einwilligung widerrufen und Foto löschen
          </Button>
        </form>
      )}
      {basis ? (
        <PhotoForm
          action={setPhotoAction}
          userId={id}
          label={`Profilbild für ${name}`}
          paper={basis === "paper"}
          consentText={consentText(basis, name)}
          today={today}
        />
      ) : (
        own && (
          <p className="text-sm text-muted">
            Ein Profilbild von Schüler:innen braucht die Einwilligung der Eltern: Sie können es in ihrem Zugang hinterlegen,
            oder das Sekretariat erfasst eine schriftliche Einwilligung.
          </p>
        )
      )}
    </div>
  );
}
