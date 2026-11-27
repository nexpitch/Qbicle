import type { Check } from '../types.ts';

export const caaCheck: Check = {
  key: 'dns.caa',
  level: 0,
  group: 'domein',
  appliesTo: 'domein',
  title: 'CAA: wie certificaten voor je domein mag uitgeven',
  async run({ domain, orgDomain, net }) {
    // RFC 8659: de CAA-records van de naam zelf (een resolver volgt een CNAME
    // vanzelf), en anders die van de bovenliggende namen tot en met het hoofddomein.
    const names: string[] = [];
    for (let n = domain; ; n = n.slice(n.indexOf('.') + 1)) {
      names.push(n);
      if (n === orgDomain || !n.includes('.')) break;
    }
    let recs: { tag: string; value: string; critical: number }[] = [];
    let foundOn: string | null = null;
    for (const n of names) {
      recs = await net.resolveCaa(n);
      if (recs.length > 0) {
        foundOn = n;
        break;
      }
    }
    const evidence = { records: recs, checked: names, foundOn };
    const issuers = recs.filter((r) => r.tag === 'issue' || r.tag === 'issuewild');
    if (issuers.length > 0) {
      const where = foundOn && foundOn !== domain ? ` (vastgelegd op ${foundOn})` : '';
      return { outcome: 'ok', evidence, message: `Toegestane uitgevers: ${[...new Set(issuers.map((r) => r.value))].join(', ')}${where}.` };
    }
    return {
      outcome: 'finding',
      evidence,
      findings: [
        {
          key: 'caa.missing',
          certainty: 'vastgesteld',
          title: 'Niet vastgelegd wie certificaten voor dit domein mag maken',
          detail:
            `${orgDomain} heeft geen CAA-record${domain !== orgDomain ? ` (ook niet op ${domain})` : ''}. Daardoor mag elke certificaatuitgever een certificaat voor dit domein maken. ` +
            'Let op bij het instellen: zet álle partijen erin die certificaten voor je maken, zoals je websitebouwer, hostingpartij en mailprovider. Vergeet je er een, dan mislukt hun volgende verlenging en is je site of mail weken later onbereikbaar.',
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
  async run({ domain: name, orgDomain, net, memo }) {
    // DNSSEC hoort bij de zone: het DS-record staat bij het hoofddomein, niet bij www of een ander subdomein.
    const domain = orgDomain;
    const s = await memo(`dnssec:${domain}`, () => net.dnssec(domain));
    if (!s) {
      return {
        outcome: 'unknown',
        message: 'We konden DNSSEC nu niet controleren omdat de validerende resolver geen antwoord gaf.',
      };
    }
    const evidence = { ...s, measuredOn: domain, asked: name };
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
