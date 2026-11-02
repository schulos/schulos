import { permanentRedirect } from "next/navigation";

/** Bis INV-01 hieß der Bereich „Anlagen“ – alte Lesezeichen landen im Inventar. */
export default function AnlagenPage() {
  permanentRedirect("/gebaeude/inventar");
}
