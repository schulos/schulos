import { describe, expect, it } from "vitest";
import { checkSvg, looksLikeSvg, SVG_MAX_DEPTH, SVG_MAX_USES, svgProblem } from "./images-svg";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns="http://www.w3.org/2000/svg"';

// Typische Ausgaben von Vektorprogrammen (nachgebaut, eigene Formen) – müssen angenommen werden.
const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="210mm" height="60mm" viewBox="0 0 210 60" version="1.1" id="svg5"
   inkscape:version="1.3 (0e150ed6c4, 2023-07-21)" sodipodi:docname="logo.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink" ${NS}
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" bordercolor="#666666" inkscape:zoom="0.7" inkscape:document-units="mm" />
  <defs id="defs2">
    <linearGradient inkscape:collect="always" id="linearGradient1">
      <stop style="stop-color:#0e7c66;stop-opacity:1;" offset="0" id="stop1" />
      <stop style="stop-color:#14181f;stop-opacity:1;" offset="1" id="stop2" />
    </linearGradient>
    <linearGradient xlink:href="#linearGradient1" id="linearGradient2" x1="10" y1="10" x2="50" y2="50" gradientUnits="userSpaceOnUse" />
  </defs>
  <metadata><rdf:RDF><cc:Work rdf:about=""><dc:title>Schullogo</dc:title></cc:Work></rdf:RDF></metadata>
  <g inkscape:label="Ebene 1" inkscape:groupmode="layer" id="layer1">
    <path style="fill:url(#linearGradient2);stroke:none;stroke-width:0.26" d="M 10,10 H 50 V 50 H 10 Z" id="rect1" sodipodi:nodetypes="ccccc" />
    <text xml:space="preserve" style="font-size:16px;font-family:sans-serif;fill:#14181f" x="60" y="36" id="text1"><tspan sodipodi:role="line" id="tspan1" x="60" y="36">Lindenhof</tspan></text>
  </g>
</svg>
`;

const ILLUSTRATOR = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Ebene_1" ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 400 120" style="enable-background:new 0 0 400 120;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#0E7C66;}
	.st1{fill:#14181F;}
	.st2{font-family:'Figtree-Bold';font-size:42px;}
</style>
<g>
	<polygon class="st0" points="20,100 60,20 100,100 	"/>
	<circle class="st1" cx="60" cy="72" r="12"/>
</g>
<text transform="matrix(1 0 0 1 120 76)" class="st1 st2">Gesamtschule</text>
</svg>
`;

const FIGMA = `<svg width="240" height="80" viewBox="0 0 240 80" fill="none" ${NS}>
<g clip-path="url(#clip0_12_7)">
<rect width="80" height="80" rx="16" fill="#0E7C66"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M20 20H60V60H20V20ZM30 30V50H50V30H30Z" fill="white"/>
<path d="M100 28H220" stroke="#14181F" stroke-width="6" stroke-linecap="round"/>
</g>
<defs>
<clipPath id="clip0_12_7">
<rect width="240" height="80" fill="white"/>
</clipPath>
</defs>
</svg>
`;

const AFFINITY = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg width="100%" height="100%" viewBox="0 0 512 512" version="1.1" ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" xmlns:serif="http://www.serif.com/" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
    <g id="Symbol" serif:id="Symbol">
        <circle cx="256" cy="256" r="240" style="fill:rgb(14,124,102);"/>
        <use xlink:href="#_Image1" x="128" y="128" width="256px" height="256px"/>
    </g>
    <defs>
        <image id="_Image1" width="256px" height="256px" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="/>
    </defs>
</svg>
`;

const SVGO = `<svg ${NS} viewBox="0 0 64 64"><defs><radialGradient id="a" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#0e7c66"/></radialGradient><style><![CDATA[.b{fill:url(#a)}]]></style></defs><path class="b" d="M8 8h48v48H8z"/><circle cx="32" cy="32" r="8" fill="#fff"/><a href="#a"><title>Logo</title></a></svg>`;

describe("SVG-Annahmefilter: echte Logo-SVGs werden angenommen", () => {
  it.each([
    ["Inkscape", INKSCAPE, { width: 210, height: 60 }],
    ["Illustrator", ILLUSTRATOR, { width: 400, height: 120 }],
    ["Figma", FIGMA, { width: 240, height: 80 }],
    ["Affinity", AFFINITY, { width: 512, height: 512 }],
    ["svgo (minifiziert, CDATA-Stil)", SVGO, { width: 64, height: 64 }],
  ])("%s", (_name, svg, size) => {
    expect(svgProblem(svg)).toBeNull();
    expect(checkSvg(enc(svg))).toEqual({ ok: true, size });
    expect(looksLikeSvg(enc(svg))).toBe(true);
  });
});

describe("SVG-Annahmefilter: Negativ-Liste", () => {
  const svg = (inner: string, attrs = "") => `<svg ${NS} viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
  it.each([
    ["Skript", svg("<script>alert(1)</script>")],
    ["Skript mit Präfix", svg('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>')],
    ["Skript in CDATA-loser Hülle", svg("<SCRIPT >alert(1)</SCRIPT>")],
    ["onload am Wurzelelement", svg("", ' onload="alert(1)"')],
    ["Ereignis groß geschrieben", svg('<g ONCLICK="alert(1)"/>')],
    ["Ereignis ohne Anführungszeichen", svg("<rect onmouseover=alert(1) width=1 height=1/>")],
    ["Ereignis im kaputten Tag", svg("<g onclick=\"alert(1)\" a='>")],
    ["foreignObject", svg('<foreignObject width="10" height="10"><div>hi</div></foreignObject>')],
    ["XHTML-Namensraum", svg('<h:img xmlns:h="http://www.w3.org/1999/xhtml" src="x"/>')],
    ["iframe", svg('<iframe src="https://example.org"/>')],
    ["embed", svg('<embed src="x.swf"/>')],
    ["object", svg('<object data="x.html"/>')],
    ["javascript:-Link", svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ["javascript: mit xlink", svg('<a xlink:href="JavaScript:alert(1)"/>')],
    ["javascript: als Zeichenreferenz", svg('<a href="&#106;avascript:alert(1)"/>')],
    ["javascript: hex mit Tab-Referenz", svg('<a href="java&#x09;script:alert(1)"/>')],
    ["javascript: mit &colon;", svg('<a href="javascript&colon;alert(1)"/>')],
    ["data:text/html", svg('<a href="data:text/html;base64,PHNjcmlwdD4="/>')],
    ["verschachteltes SVG als data-URL", svg('<image href="data:image/svg+xml;base64,PHN2Zz4=" width="1" height="1"/>')],
    ["use mit externem Verweis", svg('<use href="https://example.org/sprite.svg#a"/>')],
    ["image von fremdem Host", svg('<image xlink:href="https://tracker.example/p.png" width="1" height="1"/>')],
    ["@import im Stil", svg("<style>@import url(https://example.org/x.css);</style>")],
    ["url() auf fremden Host im style-Attribut", svg('<rect style="fill:url(https://example.org/p.svg#g)" width="1" height="1"/>')],
    ["url() relativ", svg("<style>.a{background:url('p.png')}</style>")],
    ["Animation verbiegt href", svg('<a href="#x"><set attributeName="href" to="https://example.org"/></a>')],
    ["Animation mit javascript:", svg('<animate attributeName="xlink:href" values="javascript:alert(1)"/>')],
    ["Entity (Billion Laughs)", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>${svg("<text>&lol2;</text>")}`],
    ["DOCTYPE mit externem System-Verweis", `<!DOCTYPE svg SYSTEM "file:///etc/passwd">${svg("")}`],
    ["xml-stylesheet", `<?xml version="1.0"?><?xml-stylesheet href="x.css"?>${svg("")}`],
    ["Verarbeitungsanweisung später", svg('<?php echo 1 ?>')],
    ["kein svg-Wurzelelement", `<html><body>${svg("")}</body></html>`],
    ["anderes Wurzelelement", '<?xml version="1.0"?><foo/>'],
    ["Text nach dem Ende", `${svg("")}<g/>`],
    ["nicht geschlossener Kommentar", `${svg("")}<!-- offen`],
    ["ohne Größenangabe", `<svg ${NS}><rect width="1" height="1"/></svg>`],
    ["zu tief verschachtelt", svg("<g>".repeat(SVG_MAX_DEPTH + 1) + "</g>".repeat(SVG_MAX_DEPTH + 1))],
  ])("%s wird abgelehnt", (_name, text) => {
    expect(svgProblem(text)).not.toBeNull();
    expect(checkSvg(enc(text)).ok).toBe(false);
  });

  it("Gründe sind lesbar", () => {
    expect(svgProblem(svg("<script>alert(1)</script>"))).toBe("enthält ein Skript");
    expect(svgProblem(svg("", ' onload="alert(1)"'))).toBe("enthält ein Ereignis-Attribut (onload)");
    expect(svgProblem(svg('<use href="https://example.org/a.svg#a"/>'))).toBe("verweist auf externe Inhalte");
  });

  it("Steuerzeichen im Wort javascript: helfen nicht", () => {
    const tab = String.fromCharCode(9);
    expect(svgProblem(svg(`<a href="java${tab}script:alert(1)"/>`))).not.toBeNull();
  });

  it("keine gültige UTF-8-Datei bzw. Binärdaten", () => {
    expect(checkSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toEqual({ ok: false, reason: "ist nicht als UTF-8 gespeichert" });
    expect(svgProblem(`<svg ${NS} viewBox="0 0 1 1">${String.fromCharCode(0)}</svg>`)).toBe("ist keine Textdatei");
  });
});

describe("SVG-Annahmefilter: Laufzeit linear (Security-Review Gate 4a N1, DoS)", () => {
  const MB = 1024 * 1024;
  const head = `<svg ${NS} width="10" height="10">`;
  /** ~1 MB aus dem Muster, Prüfung muss unter 1 s bleiben (vorher quadratisch: 1 MB ≈ 6 min) */
  const timed = (text: string) => {
    const t0 = performance.now();
    const r = checkSvg(enc(text));
    return { r, ms: performance.now() - t0 };
  };
  it.each([
    ["offenes Anführungszeichen nach vielen Tags", head + "<g".repeat(MB / 2) + "'</svg>"],
    ["viele url( ohne Klammer zu", `${head}<style>${"url(".repeat(MB / 4)}</style></svg>`],
    ["viele Kommentaranfänge, ein Ende", `${head}${"<!--".repeat(MB / 4)}--></svg>`],
    ["viele DOCTYPE ohne Ende", `${"<!doctype".repeat(MB / 9)}${head}</svg>`],
    ["viele href=\" ohne Ende", `${head}${' href="'.repeat(MB / 7)}</svg>`],
    ["viele attributeName=' ohne Ende", `${head}${" attributeName='".repeat(MB / 16)}</svg>`],
  ])("%s: schnell entschieden", (_name, text) => {
    expect(text.length).toBeGreaterThan(MB * 0.9);
    expect(timed(text).ms).toBeLessThan(1000);
  });

  it("das Angriffsmuster aus dem Review wird abgelehnt (vorher angenommen)", () => {
    expect(timed(head + "<g".repeat(MB / 2) + "'</svg>").r.ok).toBe(false);
    expect(timed(`${head}<style>${"url(".repeat(MB / 4)}</style></svg>`).r.ok).toBe(false);
  });

  it("ein großes, gültiges SVG wird zügig angenommen", () => {
    const text = `${head}${'<rect x="1" y="1" width="2" height="2" fill="#0e7c66"/>'.repeat(19_000)}</svg>`;
    const { r, ms } = timed(text);
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it("Tags ohne Ende werden abgelehnt (die Grenzen greifen auch bei kaputtem Markup)", () => {
    expect(svgProblem(`${head}<g fill='a></svg>`)).toBe("ist kein gültiges SVG (Element nicht geschlossen)");
    expect(svgProblem(`${head}<g><rect width="1" height="1" title="a > b"/></g></svg>`)).toBeNull();
    expect(svgProblem(`${head}${"<g/>".repeat(20_001)}</svg>`)).toBe("ist zu umfangreich");
  });

  it("viele <use> (Kaskaden) werden abgelehnt", () => {
    expect(svgProblem(`${head}<defs><g id="a"/></defs>${'<use href="#a"/>'.repeat(SVG_MAX_USES)}</svg>`)).toBeNull();
    expect(svgProblem(`${head}<defs><g id="a"/></defs>${'<use href="#a"/>'.repeat(SVG_MAX_USES + 1)}</svg>`)).toBe("hat zu viele Verweise (<use>)");
  });
});

describe("SVG erkennen", () => {
  it("nur Text, der mit Prolog oder <svg beginnt", () => {
    expect(looksLikeSvg(enc(`<svg ${NS}/>`))).toBe(true);
    expect(looksLikeSvg(enc('<?xml version="1.0"?>\n<svg/>'))).toBe(true);
    expect(looksLikeSvg(enc("<html><svg/></html>"))).toBe(false);
    expect(looksLikeSvg(enc("GIF89a"))).toBe(false);
  });
});
