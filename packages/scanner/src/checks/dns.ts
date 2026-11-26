import type { Check } from '../types.ts';

export const caaCheck: Check = {
  key: 'dns.caa',
  level: 0,
  group: 'domein',
  appliesTo: 'domein',
  title: 'CAA: wie certificaten voor je domein mag uitgeven',
  async run({ domain, net }) {
    const recs = await net.resolveCaa(domain);
    const evidence = { records: recs };
    const issuers = recs.filter((r) => r.tag === 'issue' || r.tag === 'issuewild');
    if (issuers.length > 0) {
      return { outcome: 'ok', evidence, message: `Toegestane uitgevers: ${[...new Set(issuers.map((r) => r.value))].join(', ')}.` };
    }
    return {
      outcome: 'finding',
      evidence,
      findings: [
        {
          key: 'caa.missing',
          certainty: 'vastgesteld',
          title: 'Niet vastgelegd wie certificaten voor dit domein mag maken',
          detail: `${domain} heeft geen CAA-record. Daardoor mag elke certificaatuitgever een certificaat voor dit domein maken.`,
        },
      ],
    };
  },
};

export const dnssecCheck: Check = {
  key: 'dns.dnssec',
  level: 0,
  group: 'domein',
  appliesTo: 'domein',
  title: 'DNSSEC: bescherming tegen vervalste DNS-antwoorden',
  async run({ domain, net }) {
    const s = await net.dnssec(domain);
    if (!s) {
      return {
        outcome: 'unknown',
        message: 'We konden DNSSEC nu niet controleren omdat de validerende resolver geen antwoord gaf.',
      };
    }
    const evidence = { ...s };
    if (s.bogus) {
      return {
        outcome: 'finding',
        evidence,
        findings: [
          {
            key: 'dnssec.invalid',
            certainty: 'vastgesteld',
            title: 'DNSSEC staat aan, maar klopt niet',
            detail: `Een validerende resolver weigert ${domain}. Bezoekers en mailservers die DNSSEC controleren, kunnen je domein dan niet bereiken.`,
          },
        ],
      };
    }
    if (s.hasDs && s.validated) return { outcome: 'ok', evidence };
    if (!s.hasDs) {
      return {
        outcome: 'finding',
        evidence,
        findings: [
          {
            key: 'dnssec.missing',
            certainty: 'vastgesteld',
            title: 'DNSSEC staat niet aan',
            detail: `${domain} is niet beveiligd met DNSSEC, waardoor vervalste DNS-antwoorden niet te herkennen zijn.`,
          },
        ],
      };
    }
    return {
      outcome: 'unknown',
      evidence,
      message: 'Er staat een DNSSEC-sleutel bij de registry, maar de resolver bevestigde de handtekening niet.',
    };
  },
};
