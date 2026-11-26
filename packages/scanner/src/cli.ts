#!/usr/bin/env -S npx tsx
/**
 * Opdrachtregel voor de Qbicle-scanner.
 *
 *   npm run scan -- voorbeeld.nl            samenvatting in gewone taal
 *   npm run scan -- voorbeeld.nl --json     volledig rapport als JSON
 *   npm run scan -- voorbeeld.nl --niveau 0 alleen openbare bronnen, geen verbinding met de site
 *   npm run scan -- --bestand testset.txt --uit resultaten
 *                                           testset: één domein per regel, per domein een JSON-rapport
 *
 * Alleen passieve, openbare checks. Scan alleen domeinen waarvoor je dat mag.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    bestand: { type: 'string' },
    uit: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || (positionals.length !== 1 && !values.bestand)) {
  console.log('Gebruik: qbicle-scan <domein> [--json] [--niveau 0|1]');
  console.log('         qbicle-scan --bestand <domeinen.txt> [--uit <map>] [--niveau 0|1]');
  process.exit(values.help ? 0 : 2);
}
if (values.niveau !== '0' && values.niveau !== '1') {
  console.error('Niveau moet 0 of 1 zijn. Actief testen (niveau 2) doet deze scanner niet.');
  process.exit(2);
}

const opts = {
  net: createNodeNet({
    dohUrl: process.env.QBICLE_DOH_URL || undefined,
    infoUrl: process.env.QBICLE_SCANNER_INFO_URL || undefined,
  }),
  maxLevel: (values.niveau === '0' ? 0 : 1) as 0 | 1,
  optOut: loadOptOut(process.env.QBICLE_OPTOUT_FILE || undefined),
};

const isExpected = (e: unknown) =>
  e instanceof DomainInputError || e instanceof OptOutError || e instanceof DomainNotFoundError;

if (values.bestand) {
  // Testset: domeinen na elkaar scannen (niet parallel, om netjes te blijven).
  const domains = readFileSync(values.bestand, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  if (values.uit) mkdirSync(values.uit, { recursive: true });
  const rows: string[] = ['domein;urgentie;band;dekking_pct;acties;top_actie;fout'];
  for (const d of domains) {
    try {
      const r = await scanDomain(d, opts);
      if (values.uit) writeFileSync(join(values.uit, `${r.domain}.json`), JSON.stringify(r, null, 2));
      const top = r.score.topActions[0]?.title ?? '';
      rows.push([r.domain, r.score.urgency, r.score.band.label, r.score.coverage.pct, r.score.actionCount, top, ''].join(';'));
      console.error(`${r.domain}: ${r.score.urgency}/100 (${r.score.band.label}), dekking ${r.score.coverage.pct}%`);
    } catch (e) {
      if (!isExpected(e)) console.error(e);
      rows.push([d, '', '', '', '', '', (e as Error).message.replaceAll(';', ',')].join(';'));
      console.error(`${d}: ${(e as Error).message}`);
    }
  }
  const csv = rows.join('\n') + '\n';
  if (values.uit) writeFileSync(join(values.uit, 'overzicht.csv'), csv);
  console.log(csv);
  process.exit(0);
}

try {
  const report = await scanDomain(positionals[0]!, opts);
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
} catch (e) {
  if (isExpected(e)) {
    console.error((e as Error).message);
    process.exit(2);
  }
  throw e;
}
