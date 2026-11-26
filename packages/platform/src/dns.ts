import { Resolver } from 'node:dns/promises';

/** Geeft de TXT-records van een naam; elk record als één samengevoegde string. */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[]>;
}

/** Echte DNS via het besturingssysteem, met time-out. NXDOMAIN en NODATA geven een lege lijst. */
export function systemTxtResolver(servers?: string[]): TxtResolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (servers?.length) r.setServers(servers);
  return {
    async resolveTxt(name) {
      try {
        const records = await r.resolveTxt(name);
        return records.map((chunks) => chunks.join(''));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw err;
      }
    },
  };
}
