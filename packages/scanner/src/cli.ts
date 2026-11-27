#!/usr/bin/env -S npx tsx
/**
 * Opdrachtregel voor de Qbicle-scanner.
 *
 *   npm run scan -- voorbeeld.nl            samenvatting in gewone taal
 *   npm run scan -- voorbeeld.nl --json     volledig rapport als JSON
 *   npm run scan -- voorbeeld.nl --niveau 0 alleen openbare bronnen, geen verbinding met de site
 *   npm run scan -- --bestand testset.txt --uit resultaten
 *                                           testset: één domein per regel, per domein een JSON-rapport
 *   ... --verwacht testset/verwacht.csv     vergelijk met de verwachte band per domein (kwaliteitsmeting)
 *   ... --pauze 2                           seconden tussen domeinen (standaard 2), om sites niet te belasten
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
import { DnsUnavailableError, DomainNotFoundError, OptOutError, scanDomain } from './scan.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean', default: false },
    niveau: { type: 'string', default: '1' },
    bestand: { type: 'string' },
    uit: { type: 'string' },
    verwacht: { type: 'string' },
    pauze: { type: 'string', default: '2' },
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
  e instanceof DomainInputError || e instanceof OptOutError || e instanceof DomainNotFoundError || e instanceof DnsUnavailableError;

if (values.bestand) {
  // Testset: domeinen na elkaar scannen (niet parallel, om netjes te blijven).
  const domains = readFileSync(values.bestand, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  if (values.uit) mkdirSync(values.uit, { recursive: true });
  const expected = values.verwacht ? loadExpected(values.verwacht) : new Map<string, string[]>();
  const pauseMs = Math.max(0, Number(values.pauze) || 0) * 1000;
  const rows: string[] = ['domein;urgentie;band;dekking_pct;acties;top_actie;verwacht;klopt;fout'];
  let checked = 0;
  let right = 0;
  for (const [i, d] of domains.entries()) {
    if (i > 0 && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    const want = expected.get(d.toLowerCase());
    try {
      const r = await scanDomain(d, opts);
      if (values.uit) writeFileSync(join(values.uit, `${r.domain}.json`), JSON.stringify(r, null, 2));
      const top = r.score.topActions[0]?.title ?? '';
      const ok = want ? want.includes(r.score.band.key) : null;
      if (ok !== null) {
        checked++;
        if (ok) right++;
      }
      rows.push([r.domain, r.score.urgency, r.score.band.label, r.score.coverage.pct, r.score.actionCount, top, want?.join('|') ?? '', ok === null ? '' : ok ? 'ja' : 'nee', ''].join(';'));
      console.error(`${r.domain}: ${r.score.urgency}/100 (${r.score.band.label}), dekking ${r.score.coverage.pct}%${ok === false ? `  << verwacht ${want!.join(' of ')}` : ''}`);
    } catch (e) {
      if (!isExpected(e)) console.error(e);
      if (want) checked++;
      rows.push([d, '', '', '', '', '', want?.join('|') ?? '', want ? 'nee' : '', (e as Error).message.replaceAll(';', ',')].join(';'));
      console.error(`${d}: ${(e as Error).message}`);
    }
  }
  const csv = rows.join('\n') + '\n';
  if (values.uit) writeFileSync(join(values.uit, 'overzicht.csv'), csv);
  console.log(csv);
  if (checked) console.error(`Band zoals verwacht: ${right} van ${checked} domeinen.`);
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

/** Verwachte banden per domein: "domein;weinig|aandacht", met # voor commentaar. */
function loadExpected(file: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const [d, bands] = line.replace(/#.*/, '').split(';').map((x) => x?.trim());
    if (d && bands && d !== 'domein') m.set(d.toLowerCase(), bands.split('|').map((b) => b.trim()));
  }
  return m;
}
