import { describe, expect, it } from 'vitest';
import {
  evaluateConsent,
  publicNetworkGuard,
  stripQueryValues,
  trackerForCookie,
  trackerForRequest,
  type ConsentObservations,
  type VisitObservation,
} from '../src/index.ts';

const visit = (scenario: VisitObservation['scenario'], extra: Partial<VisitObservation> = {}): VisitObservation => ({
  scenario,
  url: 'https://voorbeeld.nl/',
  loaded: true,
  banner: { found: true, platform: 'algemeen', acceptFound: true, rejectFound: true, acceptText: 'Accepteren', rejectText: 'Weigeren' },
  cookies: [],
  requests: [],
  storageKeys: [],
  ...extra,
});

const obs = (v: Partial<Record<VisitObservation['scenario'], Partial<VisitObservation>>>): ConsentObservations => ({
  domain: 'voorbeeld.nl',
  url: 'https://voorbeeld.nl/',
  startedAt: '2026-11-26T12:00:00Z',
  durationMs: 1,
  visits: {
    'geen-keuze': visit('geen-keuze', v['geen-keuze']),
    weigeren: visit('weigeren', { clicked: { target: 'reject', ok: true }, ...v.weigeren }),
    accepteren: visit('accepteren', { clicked: { target: 'accept', ok: true }, ...v.accepteren }),
  },
});

const cookie = (name: string, domain = '.voorbeeld.nl') => ({ name, domain, path: '/', expires: -1, secure: true, httpOnly: false, sameSite: 'Lax' });

describe('herkennen van trackers', () => {
  it('op cookienaam', () => {
    expect(trackerForCookie({ name: '_ga_ABC123' })?.id).toBe('google-analytics');
    expect(trackerForCookie({ name: '_hjSessionUser_1' })?.id).toBe('hotjar');
    expect(trackerForCookie({ name: 'PHPSESSID' })).toBeUndefined();
  });
  it('op host en pad: facebook.com telt alleen voor het meetpixel /tr', () => {
    expect(trackerForRequest({ host: 'www.facebook.com', url: 'https://www.facebook.com/tr?id=1' })?.category).toBe('marketing');
    expect(trackerForRequest({ host: 'www.facebook.com', url: 'https://www.facebook.com/voorbeeldbedrijf' })).toBeUndefined();
    expect(trackerForRequest({ host: 'region1.google-analytics.com', url: 'https://region1.google-analytics.com/g/collect' })?.id).toBe('google-analytics');
  });
});

describe('beoordeling', () => {
  it('pagina laadt niet: onbekend, nooit in orde', () => {
    const ev = evaluateConsent(obs({ 'geen-keuze': { loaded: false, error: 'time-out' }, weigeren: { loaded: false, error: 'time-out' } }));
    expect(ev.checks.map((c) => c.outcome)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('klik op weigeren mislukt: na weigeren is onbekend', () => {
    const ev = evaluateConsent(obs({ weigeren: { clicked: { target: 'reject', ok: false, error: 'knop bedekt' } } }));
    const c = ev.checks.find((x) => x.checkKey === 'consent.na_weigeren')!;
    expect(c.outcome).toBe('unknown');
    expect(c.message).toContain('knop bedekt');
  });

  it('banner-cookies en functionele cookies tellen niet; onbekende cookies van derden worden alleen getoond', () => {
    const ev = evaluateConsent(
      obs({ 'geen-keuze': { cookies: [cookie('CookieConsent'), cookie('PHPSESSID'), cookie('abc', '.onbekend-advertentienetwerk.com')] } }),
    );
    expect(ev.checks.find((x) => x.checkKey === 'consent.voor_keuze')!.outcome).toBe('ok');
    expect(ev.unknownThirdPartyCookies).toEqual(['abc (onbekend-advertentienetwerk.com)']);
  });

  it('geblokkeerde verzoeken tellen niet als tracker', () => {
    const ev = evaluateConsent(
      obs({ 'geen-keuze': { requests: [{ url: 'https://connect.facebook.net/x.js', host: 'connect.facebook.net', method: 'GET', resourceType: 'script', thirdParty: true, blocked: 'limiet' }] } }),
    );
    expect(ev.seen['geen-keuze']).toEqual([]);
  });

  it('accepteren verandert niets: we melden dat de meting misschien niet klopt', () => {
    expect(evaluateConsent(obs({})).measurementNote).toMatch(/klik/);
  });
});

describe('veiligheid', () => {
  it('bewaart geen waarden van query-parameters, behalve Consent Mode-signalen', () => {
    expect(stripQueryValues(new URL('https://www.google-analytics.com/g/collect?cid=123.456&uid=jan%40bedrijf.nl&gcs=G100'))).toBe(
      'https://www.google-analytics.com/g/collect?cid&uid&gcs=G100',
    );
  });
  it('standaardbewaking houdt interne adressen tegen', async () => {
    const guard = publicNetworkGuard();
    expect(await guard(new URL('http://127.0.0.1/'))).toBe('intern of gereserveerd adres');
    expect(await guard(new URL('http://[::1]/'))).toBe('intern of gereserveerd adres');
    expect(await guard(new URL('http://169.254.169.254/latest/meta-data'))).toBe('intern of gereserveerd adres');
  });
});
