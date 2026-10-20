import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ["**/.next/**", ".data/**", "**/node_modules/**", "**/next-env.d.ts", "drizzle/**", "apps/*/dist/**", ".claude/**"] },
  // npm-Workspaces: SchulOS im Root, Backupserver unter apps/backup
  { settings: { next: { rootDir: [".", "apps/backup"] } } },
  {
    // Schutz vor einem wiederkehrenden Fehler: „Platzhalter-Re-Exporte“, um ungenutzte Importe zu verstecken
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "ExportSpecifier[exported.name=/^_/]", message: "Kein Re-Export mit _-Alias – ungenutzte Importe stattdessen entfernen." },
        { selector: "ExpressionStatement > UnaryExpression[operator='void'] > Identifier", message: "Kein `void x;` – ungenutzte Importe stattdessen entfernen." },
      ],
    },
  },
];

export default config;
