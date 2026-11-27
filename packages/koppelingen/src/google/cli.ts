#!/usr/bin/env node
/**
 * Google Workspace en Google Cloud alleen-lezen uitlezen.
 *
 *   npm run google -- workspace --test                 nagebootste Google, geen netwerk
 *   npm run google -- cloud --test --te-veel           idem, met te veel rechten
 *
 *   # Echt (sleutelbestand van een serviceaccount, zie docs/google.md):
 *   QBICLE_GOOGLE_SLEUTEL=geheim/google-sleutel.json npm run google -- workspace --beheerder admin@jouwdomein.nl
 *   QBICLE_GOOGLE_SLEUTEL=geheim/google-sleutel.json npm run google -- cloud --project mijn-project
 *
 *   --json      volledige uitkomst als JSON
 *
 * Makkelijker met Docker: bash scripts/google-test.sh
 * Er wordt niets opgeslagen of verstuurd; de uitvoer gaat alleen naar je terminal.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GoogleClient, GoogleFout, leesSleutel } from './client.ts';
import type { GoogleUitkomst } from './bevinding.ts';
import { beoordeelCloud, CLOUD_SCOPES, leesCloud } from './cloud.ts';
import { TEST_NU, testClient } from './testmodus.ts';
import { beoordeelWorkspace, leesWorkspace, WORKSPACE_SCOPES } from './workspace.ts';

const TEKEN = { crit: '🔴', warn: '🟠', ok: '🟢' } as const;

function toon(titel: string, u: GoogleUitkomst) {
  console.log(`\n${titel}\n${'='.repeat(titel.length)}`);
  if (u.teVeelRechten.length) {
    console.log('\n⚠️  Let op: Qbicle heeft meer rechten gekregen dan nodig. We gebruiken ze niet, maar haal ze weg:');
    for (const r of u.teVeelRechten) console.log(`   - ${r}`);
  }
  console.log('\nBevindingen');
  if (!u.bevindingen.length) console.log('  Geen bevindingen.');
  for (const b of u.bevindingen) {
    console.log(`  ${TEKEN[b.urgentie]} ${b.titel}`);
    console.log(`     Wat te doen: ${b.actie}`);
    for (const x of b.bewijs) console.log(`       · ${x}`);
  }
  console.log('\nWat we konden lezen');
  for (const d of u.dekking) console.log(`  ${d.status === 'gecontroleerd' ? '✓' : '✗'} ${d.onderdeel}${d.reden ? `: ${d.reden}` : ''}`);
  if (u.assets.length) {
    console.log('\nGevonden assets (internetgericht)');
    for (const a of u.assets) console.log(`  - ${a.soort.padEnd(8)} ${a.waarde}${a.openbaar ? '  (openbaar)' : ''}  ← ${a.bron}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      test: { type: 'boolean' },
      'te-veel': { type: 'boolean' },
      json: { type: 'boolean' },
      beheerder: { type: 'string' },
      project: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const soort = positionals[0];
  if (values.help || (soort !== 'workspace' && soort !== 'cloud')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return values.help ? 0 : 2;
  }
  const test = values.test || process.env.QBICLE_GOOGLE === 'test';

  let client: GoogleClient;
  if (test) {
    client = testClient(soort, values['te-veel'] ? 'te_veel_rechten' : 'normaal');
    if (!values.json) console.log('Testmodus: nagebootste Google met voorbeelddata, er gaat niets over het netwerk.');
  } else {
    const pad = process.env.QBICLE_GOOGLE_SLEUTEL;
    if (!pad) {
      console.error('Zet QBICLE_GOOGLE_SLEUTEL op het pad van het sleutelbestand (JSON). Zie docs/google.md.');
      return 2;
    }
    let sleutel;
    try {
      sleutel = leesSleutel(readFileSync(pad, 'utf8'));
    } catch (e) {
      console.error(e instanceof GoogleFout ? e.message : `Kan het sleutelbestand niet lezen: ${pad}`);
      return 2;
    }
    if (soort === 'workspace' && !values.beheerder) {
      console.error('Geef met --beheerder het e-mailadres van een beheerder in Google Workspace op (bijv. --beheerder admin@jouwdomein.nl).');
      return 2;
    }
    client = new GoogleClient({ sleutel, scopes: soort === 'workspace' ? WORKSPACE_SCOPES : CLOUD_SCOPES, namens: soort === 'workspace' ? values.beheerder : undefined });
    if (!values.json) console.log(`Serviceaccount: ${sleutel.client_email}`);
  }

  const nu = test ? TEST_NU : new Date();
  try {
    const uitkomst = soort === 'workspace' ? beoordeelWorkspace(await leesWorkspace(client, nu), nu) : beoordeelCloud(await leesCloud(client, values.project ?? []));
    if (values.json) console.log(JSON.stringify(uitkomst, null, 2));
    else toon(soort === 'workspace' ? 'Google Workspace' : 'Google Cloud', uitkomst);
    return 0;
  } catch (e) {
    console.error(`\nMislukt: ${e instanceof GoogleFout ? e.message : (e as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
