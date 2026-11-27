import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { createCockpit } from './app.tsx';
import { cockpitFromEnv } from './from-env.ts';
import { hasStaff } from './core/staff.ts';

/**
 * Start de interne cockpit:  npm run cockpit   (of: bash scripts/cockpit.sh)
 * Open daarna http://localhost:3100. Zonder BREVO_API_KEY staan inloglinks in de console.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const { cockpit, secureCookies, trustProxy } = cockpitFromEnv();
const app = createCockpit(cockpit, { secureCookies, trustProxy });

const port = Number(process.env.PORT ?? 3100);
serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`Qbicle Cockpit op http://localhost:${info.port}`);
  if (!(await hasStaff(cockpit))) {
    console.log('Nog geen medewerkers. Voeg jezelf toe met: npm run cockpit:beheer -- toevoegen jij@bedrijf.nl beheerder');
  }
});
