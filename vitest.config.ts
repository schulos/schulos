import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["{src,packages/*/src,apps/*/src}/**/*.test.{ts,tsx}", "scripts/lasttest/**/*.test.ts", "scripts/*.test.ts"],
    environment: "node",
    // Mit TEST_DATABASE_URL (npm run test:pg) laufen die Integrationstests gegen echtes PostgreSQL
    globalSetup: ["src/core/db/pg-global-setup.ts"],
    testTimeout: 30_000,
    // Viele Testdateien seeden parallel eine komplette Schule – unter Last dauern Hooks länger.
    hookTimeout: 60_000,
  },
});
