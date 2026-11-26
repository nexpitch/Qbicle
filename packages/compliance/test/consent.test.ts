import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import {
  evaluateConsent,
  PROPOSED_WEIGHTS,
  runConsentCheck,
  toFindings,
  type ConsentEvaluation,
  type ConsentObservations,
} from '../src/index.ts';
import { respond } from './testsites.ts';

/**
 * End-to-end: echte headless Chromium tegen lokale testpagina's.
 * Zonder browser worden deze tests overgeslagen, behalve als
 * QBICLE_REQUIRE_BROWSER=1 (zoals in CI): dan falen ze.
 */

let browser: Browser | undefined;
let launchError: unknown;
const hits: string[] = [];

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QBICLE_CHROMIUM_PATH || undefined,
  });
} catch (e) {
  launchError = e;
  if (process.env.QBICLE_REQUIRE_BROWSER === '1') throw e;
}

const results = new Map<string, { obs: ConsentObservations; ev: ConsentEvaluation }>();
async function check(host: string) {
  let r = results.get(host);
  if (!r) {
    const obs = await runConsentCheck(`http://${host}/`, {
      browser,
      settleMs: 3000,
      timeoutMs: 10_000,
      // In de test wijst alles naar de lokale server; alleen intern.test speelt "intern adres".
      guard: async (u) => (u.hostname === 'intern.test' ? 'intern of gereserveerd adres' : undefined),
      // Alles wat de bewaking doorlaat, beantwoordt de testwereld; niets gaat het internet op.
      prepareContext: async (ctx) => {
        await ctx.route('**/*', (route) => route.fulfill(respond(route.request().url(), hits)));
      },
    });
    r = { obs, ev: evaluateConsent(obs) };
    results.set(host, r);
  }
  return r;
}
const outcome = (ev: ConsentEvaluation, key: string) => ev.checks.find((c) => c.checkKey === key)!;

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!browser)('cookiecheck in een echte browser', () => {
  beforeAll(() => {
    if (launchError) console.warn('Browser niet beschikbaar:', launchError);
  });

  it('goede site: niets vóór keuze, niets na weigeren, wel na accepteren', async () => {
    const { obs, ev } = await check('goed.test');
    expect(obs.visits['geen-keuze'].banner).toMatchObject({ found: true, platform: 'algemeen', acceptFound: true, rejectFound: true });
    expect(outcome(ev, 'consent.voor_keuze').outcome).toBe('ok');
    expect(outcome(ev, 'consent.weigeroptie').outcome).toBe('ok');
    expect(outcome(ev, 'consent.na_weigeren').outcome).toBe('ok');
    expect(ev.seen.accepteren.map((t) => t.name)).toEqual(['Google Analytics', 'Meta (Facebook) Pixel']);
    expect(obs.visits.accepteren.cookies.map((c) => c.name)).toEqual(expect.arrayContaining(['_ga', '_fbp', 'qbicle_testkeuze']));
    // Functionele sessiecookie telt niet.
    expect(ev.seen['geen-keuze']).toEqual([]);
    expect(ev.measurementNote).toBeUndefined();
  }, 60_000);

  it('foute site: trackers vóór keuze en na weigeren', async () => {
    const { ev } = await check('fout.test');
    const voor = outcome(ev, 'consent.voor_keuze');
    expect(voor.outcome).toBe('finding');
    const names = voor.findings.map((f) => f.discriminator);
    expect(names).toEqual(['Google Ads en DoubleClick', 'Google Analytics', 'Meta (Facebook) Pixel']);
    // Marketing = vastgesteld, analytisch = mogelijk (kan privacyvriendelijk zijn ingesteld).
    expect(voor.findings.find((f) => f.discriminator === 'Meta (Facebook) Pixel')!.certainty).toBe('vastgesteld');
    expect(voor.findings.find((f) => f.discriminator === 'Google Analytics')!.certainty).toBe('mogelijk');
    const na = outcome(ev, 'consent.na_weigeren');
    expect(na.outcome).toBe('finding');
    expect(na.findings.every((f) => f.key === 'consent.tracking_after_reject')).toBe(true);
  }, 60_000);

  it('Consent Mode: Google meet zonder cookie met "geweigerd", dat is een mogelijk risico', async () => {
    const { ev } = await check('consentmode.test');
    const voor = outcome(ev, 'consent.voor_keuze');
    expect(voor.findings).toHaveLength(1);
    expect(voor.findings[0]).toMatchObject({ certainty: 'mogelijk', discriminator: 'Google Analytics' });
    expect(voor.findings[0]!.detail).toContain('Consent Mode');
    expect(ev.seen['geen-keuze'][0]!.consentModeDenied).toBe(true);
    expect(ev.seen.accepteren[0]!.cookies).toContain('_ga');
  }, 60_000);

  it('alleen een akkoordknop: weigeroptie ontbreekt, na weigeren onbekend', async () => {
    const { ev } = await check('alleenakkoord.test');
    const w = outcome(ev, 'consent.weigeroptie');
    expect(w.outcome).toBe('finding');
    expect(w.findings[0]!.key).toBe('consent.no_reject_first_layer');
    expect(outcome(ev, 'consent.na_weigeren').outcome).toBe('unknown');
    expect(outcome(ev, 'consent.voor_keuze').outcome).toBe('ok');
  }, 60_000);

  it('schone site zonder banner: niets van toepassing, niets gevonden', async () => {
    const { ev } = await check('schoon.test');
    expect(outcome(ev, 'consent.voor_keuze').outcome).toBe('ok');
    expect(outcome(ev, 'consent.weigeroptie').outcome).toBe('not_applicable');
    expect(outcome(ev, 'consent.na_weigeren').outcome).toBe('not_applicable');
  }, 60_000);

  it('geen banner maar wel tracking: banner ontbreekt', async () => {
    const { ev } = await check('geenbanner.test');
    expect(outcome(ev, 'consent.weigeroptie').findings[0]!.key).toBe('consent.banner_missing');
    expect(outcome(ev, 'consent.voor_keuze').findings[0]!.discriminator).toBe('Meta (Facebook) Pixel');
  }, 60_000);

  it('herkent OneTrust en houdt verzoeken naar interne adressen tegen', async () => {
    const { obs, ev } = await check('onetrust.test');
    expect(obs.visits['geen-keuze'].banner.platform).toBe('onetrust');
    expect(obs.visits.weigeren.clicked).toEqual({ target: 'reject', ok: true });
    expect(outcome(ev, 'consent.na_weigeren').outcome).toBe('ok');
    const blocked = obs.visits['geen-keuze'].requests.find((r) => r.host === 'intern.test');
    expect(blocked?.blocked).toBe('intern of gereserveerd adres');
    expect(hits).not.toContain('intern.test/admin.png');
  }, 60_000);

  it('volgt geen doorverwijzing naar een ander domein', async () => {
    const { obs } = await check('doorsturen.test');
    const nav = obs.visits['geen-keuze'].requests.find((r) => r.host === 'elders.test');
    expect(nav?.blocked).toMatch(/ander domein/);
    expect(hits).not.toContain('elders.test/');
  }, 60_000);

  it('levert bevindingen in het bestaande model, met gewichten voor elke sleutel', async () => {
    const { ev } = await check('fout.test');
    const asset = { type: 'website' as const, value: 'http://fout.test/', source: 'opgegeven', visibility: 'primair' as const };
    const findings = toFindings(ev.checks, asset);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(PROPOSED_WEIGHTS[f.key]).toBeDefined();
    }
    // Zelfde tracker op hetzelfde asset = zelfde vingerafdruk over scans heen.
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
  }, 60_000);
});
