import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  BANDS,
  WEIGHTS,
  bandFor,
  coverageOf,
  exploitFactor,
  score,
  urgencyFromWeight,
  type Finding,
} from '../src/index.ts';

let n = 0;
function f(key: string, over: Partial<Finding> = {}): Finding {
  n += 1;
  return {
    key,
    checkKey: 'test',
    asset: { type: 'domein', value: 'voorbeeld.nl', source: 'opgegeven', visibility: 'primair' },
    certainty: 'vastgesteld',
    title: key,
    detail: key,
    fingerprint: `fp-${n}`,
    ...over,
  };
}

describe('afvlakking', () => {
  it('volgt 100 × (1 − e^(−som/60)) uit het prototype', () => {
    expect(urgencyFromWeight(0)).toBe(0);
    expect(urgencyFromWeight(20)).toBe(28);
    expect(urgencyFromWeight(60)).toBe(63);
    expect(urgencyFromWeight(1000)).toBe(100);
  });
});

describe('banden', () => {
  it.each([
    [0, 'Weinig urgent'],
    [24, 'Weinig urgent'],
    [25, 'Aandacht nodig'],
    [49, 'Aandacht nodig'],
    [50, 'Hoge urgentie'],
    [74, 'Hoge urgentie'],
    [75, 'Direct oppakken'],
    [100, 'Direct oppakken'],
  ])('%i → %s', (u, label) => expect(bandFor(u).label).toBe(label));

  it('KEV zet de band minimaal op Hoge urgentie', () => {
    const r = score({
      findings: [f('web.version_disclosed', { vulns: [{ cveId: 'CVE-2024-0001', inKev: true }] })],
      outcomes: ['finding'],
    });
    expect(r.urgency).toBeLessThan(50);
    expect(r.band.label).toBe('Hoge urgentie');
    expect(r.bandRaisedByKev).toBe(true);
  });
});

describe('factoren', () => {
  it('misbruikfactor m', () => {
    expect(exploitFactor(undefined)).toBe(1);
    expect(exploitFactor([{ cveId: 'a', epss: 0.05 }])).toBe(1);
    expect(exploitFactor([{ cveId: 'a', epss: 0.2 }])).toBe(1.5);
    expect(exploitFactor([{ cveId: 'a', ncscHigh: true }])).toBe(1.5);
    expect(exploitFactor([{ cveId: 'a', dtcWarning: true }])).toBe(1.5);
    expect(exploitFactor([{ cveId: 'a', ncscHigh: true, inKev: true }])).toBe(2);
  });

  it('zichtbaarheid z en zekerheid k', () => {
    const r = score({
      findings: [
        f('dmarc.missing'),
        f('dmarc.missing', { asset: { type: 'subdomein', value: 'a.voorbeeld.nl', source: 'ct', visibility: 'subdomein' } }),
        f('web.cookie_no_httponly', { certainty: 'mogelijk' }),
        f('spf.missing', { certainty: 'onbekend' }),
      ],
      outcomes: [],
    });
    expect(r.contributions.map((c) => c.weight)).toEqual([20, 14, 1, 0]);
    expect(r.totalWeight).toBe(35);
  });

  it('Onbekend telt nooit mee en levert geen actie op', () => {
    const r = score({ findings: [f('cert.expired', { certainty: 'onbekend' })], outcomes: ['unknown'] });
    expect(r.urgency).toBe(0);
    expect(r.topActions).toEqual([]);
  });
});

describe('acties', () => {
  it('groepeert per actie en toont maximaal drie, zwaarste eerst', () => {
    const r = score({
      findings: [
        f('web.hsts_missing'),
        f('web.csp_missing'),
        f('web.xcto_missing'),
        f('dmarc.missing'),
        f('cert.expires_14d'),
        f('caa.missing'),
        f('dnssec.missing'),
      ],
      outcomes: [],
    });
    expect(r.actionCount).toBe(5);
    expect(r.topActions.map((a) => a.key)).toEqual(['cert-automatisch', 'dmarc-instellen', 'website-headers']); // gelijk gewicht: alfabetisch
    expect(r.topActions[2]).toMatchObject({ weight: 10, findingCount: 3 });
  });

  it('dubbele vingerafdruk telt één keer', () => {
    const a = f('dmarc.missing');
    expect(score({ findings: [a, { ...a }], outcomes: [] }).totalWeight).toBe(20);
  });

  it('onbekende sleutel telt zichtbaar mee', () => {
    const r = score({ findings: [f('iets.nieuws')], outcomes: [] });
    expect(r.unknownKeys).toEqual(['iets.nieuws']);
    expect(r.totalWeight).toBeGreaterThan(0);
  });

  it('elke sleutel verwijst naar een bestaande actie', () => {
    for (const [k, w] of Object.entries(WEIGHTS)) expect(ACTIONS[w.action], k).toBeDefined();
  });
});

describe('dekking', () => {
  it('afgerond gedeeld door toepasselijk', () => {
    expect(coverageOf(['ok', 'finding', 'unknown', 'error', 'not_applicable'])).toEqual({ done: 2, applicable: 4, pct: 50 });
    expect(coverageOf([])).toEqual({ done: 0, applicable: 0, pct: 0 });
  });
});

it('banden zijn oplopend', () => {
  for (let i = 1; i < BANDS.length; i++) expect(BANDS[i]!.min).toBeGreaterThan(BANDS[i - 1]!.min);
});
