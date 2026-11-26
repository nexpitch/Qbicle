#!/usr/bin/env -S npx tsx
/**
 * Opdrachtregel voor de Qbicle-scanner.
 *
 *   npm run scan -- voorbeeld.nl            samenvatting in gewone taal
 *   npm run scan -- voorbeeld.nl --json     volledig rapport als JSON
 *   npm run scan -- voorbeeld.nl --niveau 0 alleen openbare bronnen, geen verbinding met de site
 *
 * Alleen passieve, openbare checks. Scan alleen domeinen waarvoor je dat mag.
 */
import { parseArgs } from 'node:util';
import { DomainInputError } from './domain.ts';
import { createNodeNet } from './net.ts';
import { loadOptOut } from './optout.ts';
import { formatReport } from './report.ts';
import { DomainNotFoundError, OptOutError, scanDomain } from './scan.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    niveau: { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log('Gebruik: qbicle-scan <domein> [--json] [--niveau 0|1]');
  process.exit(values.help ? 0 : 2);
}
if (values.niveau !== '0' && values.niveau !== '1') {
  console.error('Niveau moet 0 of 1 zijn. Actief testen (niveau 2) doet deze scanner niet.');
  process.exit(2);
}

try {
  const report = await scanDomain(positionals[0]!, {
    net: createNodeNet({
      dohUrl: process.env.QBICLE_DOH_URL || undefined,
      infoUrl: process.env.QBICLE_SCANNER_INFO_URL || undefined,
    }),
    maxLevel: values.niveau === '0' ? 0 : 1,
    optOut: loadOptOut(process.env.QBICLE_OPTOUT_FILE || undefined),
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
} catch (e) {
  if (e instanceof DomainInputError || e instanceof OptOutError || e instanceof DomainNotFoundError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}
