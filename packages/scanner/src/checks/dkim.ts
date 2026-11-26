import type { Check } from '../types.ts';

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

export const dkimCheck: Check = {
  key: 'mail.dkim',
  level: 0,
  group: 'e-mail',
  appliesTo: 'domein',
  title: 'DKIM: digitale handtekening onder je mail',
  async run({ domain, net }) {
    const found: { selector: string; revoked: boolean }[] = [];
    let failures = 0;
    await Promise.all(
      DKIM_SELECTORS.map(async (selector) => {
        try {
          const txt = await net.resolveTxt(`${selector}._domainkey.${domain}`);
          const rec = txt.find((t) => /(^|;)\s*(v=dkim1|p=)/i.test(t));
          if (rec) found.push({ selector, revoked: /(^|;)\s*p=\s*(;|$)/i.test(rec) });
        } catch {
          failures += 1;
        }
      }),
    );
    found.sort((a, b) => a.selector.localeCompare(b.selector));
    const active = found.filter((f) => !f.revoked);
    const evidence = { tried: DKIM_SELECTORS.length, found, failures };

    if (active.length > 0) {
      return { outcome: 'ok', evidence, message: `DKIM-sleutel gevonden (${active.map((f) => f.selector).join(', ')}).` };
    }
    return {
      outcome: 'unknown',
      evidence,
      message:
        'We vonden geen DKIM-sleutel bij de bekende namen van grote mailproviders. Dat betekent niet dat DKIM ontbreekt; je IT-partner kan dit snel bevestigen.',
    };
  },
};
