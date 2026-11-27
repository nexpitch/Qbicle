import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EOL_PRODUCTS, parseEndoflifeMarkdown, type EolSnapshot } from './eol.ts';

/**
 * Ververst eol-snapshot.json uit de openbare bronbestanden van endoflife.date
 * (GitHub-repository endoflife-date/endoflife.date, map products/).
 *
 *   npm run kennis:bijwerken            schrijft de snapshot naast eol.ts
 *   npm run kennis:bijwerken -- pad.json schrijft naar een ander bestand
 *
 * Draait los van de scans (bijvoorbeeld wekelijks). Mislukt één product, dan
 * stopt het script zonder iets te overschrijven: liever een oude dan een halve snapshot.
 */
const BASE = 'https://raw.githubusercontent.com/endoflife-date/endoflife.date/master/products';

async function main() {
  const out = process.argv[2] ?? fileURLToPath(new URL('./eol-snapshot.json', import.meta.url));
  const snap: EolSnapshot = { stand: new Date().toISOString().slice(0, 10), bron: 'https://endoflife.date', producten: {} };
  for (const slug of EOL_PRODUCTS) {
    const res = await fetch(`${BASE}/${slug}.md`, { headers: { 'user-agent': 'qbicle-kennis-bijwerken' } });
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
    const cycles = parseEndoflifeMarkdown(await res.text());
    if (cycles.length === 0) throw new Error(`${slug}: geen reeksen gevonden`);
    snap.producten[slug] = cycles;
    console.log(`${slug.padEnd(20)} ${cycles.length} reeksen, nieuwste ${cycles[0]!.cycle} (${cycles[0]!.latest ?? '?'})`);
  }
  writeFileSync(out, JSON.stringify(snap, null, 1) + '\n');
  console.log(`Geschreven: ${out} (stand ${snap.stand})`);
}

main().catch((e) => {
  console.error(`Bijwerken mislukt, niets overschreven: ${(e as Error).message}`);
  process.exit(1);
});
