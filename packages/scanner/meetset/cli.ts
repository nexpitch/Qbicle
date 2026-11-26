#!/usr/bin/env -S npx tsx
/**
 * Vaste meetset draaien en de kwaliteit in gewone taal tonen.
 *
 *   npm run meetset            tabel en samenvatting
 *   npm run meetset -- --json  ruwe uitkomst, bijvoorbeeld om versies te vergelijken
 */
import { runMeetset } from './meet.ts';

const { results, summary: s } = await runMeetset();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ results, summary: s }, null, 2));
} else {
  for (const r of results) {
    const mark = r.goed ? 'goed ' : 'FOUT ';
    console.log(`${mark} ${r.id.padEnd(38)} ${String(r.urgentie ?? '-').padStart(3)}  ${r.band ?? ''}`);
    for (const g of r.gemist) console.log(`        gemist: ${g}`);
    for (const v of r.vals) console.log(`        vals:   ${v}`);
    for (const o of r.overig) console.log(`        anders: ${o}`);
    if (!r.bandGoed) console.log('        band klopt niet');
  }
  console.log('');
  console.log(`Scenario's helemaal goed: ${s.helemaalGoed} van ${s.scenarios}`);
  console.log(`Juiste urgentieband:      ${s.bandGoed} van ${s.scenarios}`);
  console.log(`Verwachte bevindingen:    ${s.gevonden} van ${s.verwachteBevindingen} gevonden (${s.gemist} gemist)`);
  console.log(`Valse bevindingen:        ${s.vals}`);
  console.log(`Overige afwijkingen:      ${s.overig}`);
}
process.exitCode = s.helemaalGoed === s.scenarios ? 0 : 1;
