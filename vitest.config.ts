import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Bouwt eenmalig een sjabloondatabase voor de databasetests (alleen als DATABASE_URL gezet is).
    globalSetup: ['packages/platform/test/support/global-setup.ts'],
  },
});
