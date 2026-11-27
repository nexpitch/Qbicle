import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Vaste kennis-snapshot voor tests, zodat een nieuwe endoflife.date-stand geen tests breekt.
    env: { QBICLE_EOL_FILE: 'packages/scanner/test/fixtures/eol-snapshot.json' },
    // Bouwt eenmalig een sjabloondatabase voor de databasetests (alleen als DATABASE_URL gezet is).
    globalSetup: ['packages/platform/test/support/global-setup.ts'],
  },
});
