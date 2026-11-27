import type { Net } from '../net.ts';
import type { Check } from '../types.ts';
import { mailTarget, measuredOnNote } from './maildomain.ts';

/**
 * Bekende DKIM-selectors van veelgebruikte mailproviders.
 * DKIM-selectors zijn niet op te vragen; we kunnen alleen raden.
 * Niets gevonden betekent daarom "onbekend", nooit "ontbreekt".
 */
export const DKIM_SELECTORS = [
  'selector1', // Microsoft 365
  'selector2', // Microsoft 365
  'google', // Google Workspace
  'default',
  'dkim',
  'mail',
  'k1', // Mailchimp / Mandrill
  'k2',
  's1', // SendGrid
  's2',
  'mxvault',
  'zoho', // Zoho
  'zmail',
  'protonmail', // Proton
  'protonmail2',
  'protonmail3',
  'mailjet', // Mailjet
  'smtp',
  'key1',
];

/** Naam die niet kan bestaan: geeft die ook een "sleutel", dan is er een wildcard-record. */
const WILDCARD_PROBE = 'qbicle-bestaat-niet-7f3a';

/** Een echt DKIM-record: v=DKIM1, of een p= met een sleutel. Geen DMARC- of SPF-tekst uit een wildcard. */
export function isDkimRecord(txt: string): boolean {
  const t = txt.trim();
  if (/^v=(dmarc1|spf1)\b/i.test(t)) return false;
  return /(^|;)\s*v=dkim1\s*(;|$)/i.test(t) || /(^|;)\s*p=[A-Za-z0-9+/=]{16,}/.test(t);
}

export interface DkimProbe {
  tried: number;
  found: { selector: string; revoked: boolean }[];
  active: { selector: string; revoked: boolean }[];
  failures: number;
  wildcard: boolean;
}

export async function probeDkim(net: Net, domain: string): Promise<DkimProbe> {
  const found: { selector: string; revoked: boolean; rec: string }[] = [];
  let failures = 0;
  const wildcardRec = await net
    .resolveTxt(`${WILDCARD_PROBE}._domainkey.${domain}`)
    .then((t) => t.find(isDkimRecord) ?? null)
    .catch(() => null);
  await Promise.all(
    DKIM_SELECTORS.map(async (selector) => {
      try {
        const txt = await net.resolveTxt(`${selector}._domainkey.${domain}`);
        const rec = txt.find(isDkimRecord);
        if (rec && rec !== wildcardRec) found.push({ selector, revoked: /(^|;)\s*p=\s*(;|$)/i.test(rec), rec });
      } catch {
        failures += 1;
      }
    }),
  );
  found.sort((a, b) => a.selector.localeCompare(b.selector));
  const list = found.map(({ selector, revoked }) => ({ selector, revoked }));
  return { tried: DKIM_SELECTORS.length, found: list, active: list.filter((f) => !f.revoked), failures, wildcard: wildcardRec !== null };
}

export const dkimCheck: Check = {
  key: 'mail.dkim',
  level: 0,
  group: 'e-mail',
  appliesTo: 'domein',
  title: 'DKIM: digitale handtekening onder je mail',
  async run(ctx) {
    const target = await mailTarget(ctx);
    const probe = await ctx.memo(`dkim:${target.name}`, () => probeDkim(ctx.net, target.name));
    const evidence = { measuredOn: target.name, tried: probe.tried, found: probe.found, failures: probe.failures, wildcard: probe.wildcard };
    const note = measuredOnNote(ctx.domain, target);

    if (probe.active.length > 0) {
      return { outcome: 'ok', evidence, message: `DKIM-sleutel gevonden (${probe.active.map((f) => f.selector).join(', ')}).${note}` };
    }
    return {
      outcome: 'unknown',
      evidence,
      message:
        'We vonden geen DKIM-sleutel bij de bekende namen van grote mailproviders. Dat betekent niet dat DKIM ontbreekt; je IT-partner kan dit snel bevestigen.' +
        note,
    };
  },
};
