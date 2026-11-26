#!/usr/bin/env -S npx tsx
/**
 * Cookiecheck vanaf de opdrachtregel (proof of concept).
 *
 *   npm run consent -- https://www.voorbeeld.nl          samenvatting
 *   npm run consent -- https://www.voorbeeld.nl --json   waarnemingen en beoordeling als JSON
 *
 * Bezoekt de site drie keer als gewone bezoeker. Controleer alleen sites waarvoor je dat mag.
 */
import { parseArgs } from 'node:util';
import { loadOptOut, normalizeDomain } from '@qbicle/scanner';
import { evaluateConsent } from './evaluate.ts';
import { formatConsentReport } from './report.ts';
import { runConsentCheck } from './visit.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
});
if (values.help || positionals.length !== 1) {
  console.log('Gebruik: qbicle-consent <url> [--json]');
  process.exit(values.help ? 0 : 2);
}
const input = positionals[0]!;
const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
const host = new URL(url).hostname;
const optOut = loadOptOut(process.env.QBICLE_OPTOUT_FILE || undefined);
const domain = normalizeDomain(host).replace(/^www\./, '');
if ([...optOut].some((d) => domain === d || domain.endsWith(`.${d}`))) {
  console.error(`${domain} staat op de opt-outlijst. We controleren deze site niet.`);
  process.exit(3);
}
const obs = await runConsentCheck(url, { domain, infoUrl: process.env.QBICLE_SCANNER_INFO_URL || undefined });
const ev = evaluateConsent(obs);
console.log(values.json ? JSON.stringify({ observations: obs, evaluation: ev }, null, 2) : formatConsentReport(obs, ev));
