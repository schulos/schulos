import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "heute",
  name: "Heute",
  description: "Startseite mit Tagesleiste und Widgets aller Module",
  icon: "House",
  section: "start",
  mobile: 1,
  core: true,
  nav: [{ href: "/", label: "Heute" }],
});
