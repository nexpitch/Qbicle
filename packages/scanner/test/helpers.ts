import type { Asset } from '@qbicle/score';
import type { Net } from '../src/net.ts';
import { organizationalDomain } from '../src/domain.ts';
import type { Check, CheckContext } from '../src/types.ts';

export const NOW = new Date('2026-11-26T12:00:00Z');

export function ctxFor(net: Net, domain = 'voorbeeld.nl', asset?: Asset): CheckContext {
  const cache = new Map<string, Promise<unknown>>();
  return {
    domain,
    orgDomain: organizationalDomain(domain),
    asset: asset ?? { type: 'domein', value: domain, source: 'opgegeven', visibility: 'primair' },
    net,
    now: NOW,
    memo: (k, fn) => {
      if (!cache.has(k)) cache.set(k, fn());
      return cache.get(k) as never;
    },
  };
}

export function website(host: string): Asset {
  return { type: 'website', value: `https://${host}`, source: 'dns', visibility: 'primair' };
}

export async function keysOf(check: Check, ctx: CheckContext) {
  const out = await check.run(ctx);
  return { outcome: out.outcome, keys: (out.findings ?? []).map((f) => f.key).sort(), out };
}
