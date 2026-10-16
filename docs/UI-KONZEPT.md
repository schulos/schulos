# SchulOS – UI-Konzept

Mockup-Canvas: https://claude.ai/artifact/Dt4hzLPUit9N7XxPTvgmpV (privat)

## Leitideen (für beide Richtungen)

1. **„Heute" statt Modulliste.** Die Startseite beantwortet die Frage *Was ist jetzt dran?*.
   Ganz oben steht die **Tagesleiste** mit allen Stunden des Tages: die laufende Stunde ist
   hervorgehoben, Vertretungen sind orange markiert, ausfallende Stunden durchgestrichen.
   Darunter folgen rollenabhängige Widgets aus der Modul-Registry.
2. **Module sind Apps.** Die Sidebar (A) oder das Dock (B) zeigt die wichtigsten Apps, alle
   übrigen stehen unter „Alle Apps". Abgeschaltete Module verschwinden überall.
3. **Strg+K für alles.** Über die Palette erreicht man Personen, Klassen, Aufgaben und Befehle
   („Elternbrief an 7b", „Vertretung eintragen").
4. **Gong** ist die Benachrichtigungszentrale. Sie bekommt einen eigenen Namen, weil der
   Schulgong den Schultag taktet.
5. **Fachfarben** werden durchgängig verwendet: Deutsch orange, Mathe blau, Englisch violett,
   Bio grün usw. Sie erscheinen als Balken oder Punkt und nie als Textfarbe (wegen Kontrast).
6. **Schulfarbe** ist der eine Akzent, den jede Schule selbst einstellen kann.
7. **Mobil zuerst für Schüler:innen und Eltern**, mit einer Bottom-Bar: Heute · Plan ·
   Aufgaben · Chat · Mehr.
8. **Fortschritt sichtbar machen**, zum Beispiel „22 von 27 abgegeben" oder „19 von 27 Eltern
   haben bestätigt", jeweils mit einer direkten Aktion daneben („8 Familien erinnern").

## Richtung A – „Klar"
Hell und luftig, mit klassischer Sidebar nach Bereichen gruppiert (Kommunikation /
Unterricht / Organisation). Schriften: Bricolage Grotesque für Überschriften, Figtree für
Text. Wirkt vertraut und ist für Lehrkräfte ohne Technikaffinität leicht zu bedienen.
Dunkelmodus als Variante.

## Richtung B – „Dock"
Dunkel und OS-artig, ohne Sidebar. Unten sitzt ein schwebendes App-Dock, oben eine große
„Jetzt"-Karte mit Live-Fortschritt der Stunde und Schnellaktionen (Klassenbuch,
Schnellumfrage), rechts der Gong als Aktivitätsstrom. Schriften: Space Grotesk, Zeiten in
JetBrains Mono. Passt am stärksten zum Namen *SchulOS*, ist aber ungewohnter.

## Entscheidung (2026-10-03)
**Richtung A „Klar" mit vollwertigem Dark-Mode.** Mobil mit Bottom-Bar wie im Mobil-Mockup.
Tokens: Ground `#F4F5F7`, Surface `#FFFFFF`, Border `#E3E6EB`, Ink `#14181F`, Muted `#5B6472`,
Schulfarbe (Default) `#0E7C66`, Vertretung `#FFF4EC`/`#8A3B00`.
