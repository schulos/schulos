// Demo-Logo „Gesamtschule am Lindenhof“ (P4-05): selbst gebaut aus Grundformen – eine stilisierte Linde
// (drei Kreise als Krone, Stamm) auf einer abgerundeten Fläche in der Schulfarbe. Keine fremde Grafik.

const TREE = `<rect width="96" height="96" rx="22" fill="#0E7C66"/>
  <circle cx="48" cy="34" r="17" fill="#E9F5F1"/>
  <circle cx="34" cy="48" r="14" fill="#CFE9E1"/>
  <circle cx="62" cy="48" r="14" fill="#CFE9E1"/>
  <rect x="44" y="50" width="8" height="28" rx="3" fill="#E9F5F1"/>
  <rect x="26" y="76" width="44" height="5" rx="2.5" fill="#E9F5F1"/>`;

/** Symbol (quadratisch) – Favicon und Monitor-Ecke */
export const LINDENHOF_SYMBOL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <title>Gesamtschule am Lindenhof</title>
  ${TREE}
</svg>
`;

/** Logo mit Schriftzug (quer) */
export const LINDENHOF_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" width="360" height="96">
  <title>Gesamtschule am Lindenhof</title>
  ${TREE}
  <text x="112" y="40" font-family="system-ui, sans-serif" font-size="17" font-weight="600" letter-spacing="1.5" fill="#0E7C66">GESAMTSCHULE AM</text>
  <text x="110" y="78" font-family="system-ui, sans-serif" font-size="40" font-weight="800" fill="#14181F">Lindenhof</text>
</svg>
`;

/** Logo für dunkle Darstellung: heller Schriftzug */
export const LINDENHOF_LOGO_DARK_SVG = LINDENHOF_LOGO_SVG.replace('fill="#0E7C66">GESAMTSCHULE', 'fill="#7FD3BC">GESAMTSCHULE').replace('fill="#14181F"', 'fill="#ECEFF4"');
