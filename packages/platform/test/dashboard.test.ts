import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, getAssetDetail, getDashboard, inviteMember, acceptInvitation, extractToken, seedDemoData, sourcesFor } from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe('bronnen per bevinding', () => {
  it('voegt NVD, EUVD en KEV toe en laat alleen https-links door', () => {
    const s = sourcesFor(
      [{ name: 'php.net', url: 'https://www.php.net/supported-versions.php' }, { name: 'fout', url: 'javascript:alert(1)' }],
      [{ finding_id: 'x', cve_id: 'CVE-2024-21762', euvd_id: 'EUVD-2024-1', cvss: '9.8', in_kev: true, epss: null }],
    );
    expect(s.map((x) => x.name)).toEqual(['php.net', 'NVD CVE-2024-21762', 'EUVD EUVD-2024-1', 'CISA KEV (wordt actief misbruikt)']);
  });
});

describe.skipIf(!hasDb)('klantdashboard', () => {
  let p: TestPlatform;
  let eigenaar: U;
  let lezer: U;
  let vreemde: U;
  let org: string;

  beforeAll(async () => {
    process.env.QBICLE_DEMODATA = 'aan';
    p = await createTestPlatform();
    eigenaar = await loginAs(p, 'eva@drukkerij.nl');
    lezer = await loginAs(p, 'lex@drukkerij.nl');
    vreemde = await loginAs(p, 'iemand@elders.nl');
    org = (await createOrganization(p, eigenaar, { name: 'Drukkerij Eva', kind: 'klant' })).id;
    await inviteMember(p, eigenaar, org, { email: 'lex@drukkerij.nl', role: 'lezer' });
    await acceptInvitation(p, lezer, extractToken(p.mailer.last('lex@drukkerij.nl')!.text, 'qbu_')!);
  });
  afterAll(async () => {
    delete process.env.QBICLE_DEMODATA;
    await p?.close();
  });

  it('een lege organisatie krijgt als volgende stap: domein toevoegen', async () => {
    const d = await getDashboard(p, eigenaar.userId, org);
    expect(d.hasData).toBe(false);
    expect(d.urgency).toBe(0);
    expect(d.nextStep.title).toMatch(/domein toe/);
    expect(d.meldingen[0]!.text).toMatch(/nog geen domein/);
    expect(d.trend).toEqual([]);
    expect(d.scanPlan).toEqual({ status: 'geen_domein', volgende: null });
  });

  it('met voorbeelddata: urgentie, acties, assets per soort, trend en wat is opgelost', async () => {
    const now = new Date();
    await seedDemoData(p, eigenaar, org, now);
    const d = await getDashboard(p, eigenaar.userId, org, now);
    expect(d.hasData).toBe(true);
    expect(d.urgency).toBeGreaterThan(0);
    expect(d.actions.length).toBeGreaterThan(3);
    expect(d.actions[0]!.weight).toBeGreaterThanOrEqual(d.actions[1]!.weight);
    // Alle soorten assets, niet alleen websites.
    const groups = Object.fromEntries(d.groups.map((g) => [g.key, g.count]));
    expect(groups).toMatchObject({ websites: 3, mail: 1, servers: 1, cloud: 2, netwerk: 2, apparaten: 3 });
    // Opgelost in de afgelopen 30 dagen: DMARC, NAS-poort, https-doorsturen, MFA, SPF.
    expect(d.resolved.map((r) => r.title).join('|')).toMatch(/tweestapsverificatie/);
    expect(d.counts.resolved).toBe(5);
    // Trend: eerst omhoog (meer gevonden), daarna omlaag (opgelost).
    expect(d.trend.length).toBe(13);
    expect(Math.max(...d.trend.map((t) => t.urgency))).toBeGreaterThan(d.trend.at(-1)!.urgency);
    expect(d.trend.at(-1)!.urgency).toBe(d.urgency);
    expect(d.urgencyBefore).toBeGreaterThan(d.urgency);
    expect(d.coverage!.pct).toBeGreaterThan(80);
    expect(d.meldingen.some((m) => /verloopt binnen 14 dagen/.test(m.text))).toBe(true);
    expect(d.nextStep.href).toMatch(new RegExp(`^/o/${org}/assets/`));
    expect(d.activity.length).toBeGreaterThan(2);
    // Volgende wekelijkse controle: laatste geslaagde scan + 7 dagen.
    expect(d.scanPlan.status).toBe('gepland');
    expect(d.scanPlan.volgende!.getTime()).toBe(d.lastScanAt!.getTime() + 7 * 86400000);
  });

  it('opnieuw vullen vervangt de voorbeelddata in plaats van te verdubbelen', async () => {
    await seedDemoData(p, eigenaar, org);
    const d = await getDashboard(p, eigenaar.userId, org);
    expect(d.counts.assets).toBe(15);
  });

  it('detail per asset: bevindingen met bron en kwetsbaarheden', async () => {
    const d = await getDashboard(p, eigenaar.userId, org);
    const vpn = d.assets.find((a) => a.label.startsWith('vpn.'))!;
    const detail = await getAssetDetail(p, lezer.userId, org, vpn.id);
    expect(detail.open[0]!.vulns[0]).toMatchObject({ cveId: 'CVE-2024-21762', inKev: true });
    expect(detail.open[0]!.sources.map((s) => s.name)).toContain('NVD CVE-2024-21762');
    expect(detail.open[0]!.certainty).toBe('mogelijk');
    const nas = d.assets.find((a) => a.label.startsWith('Synology'))!;
    expect((await getAssetDetail(p, eigenaar.userId, org, nas.id)).components[0]).toMatchObject({ product: 'DSM' });
  });

  it('website-detail: software en server met zekerheid, wie het bijwerkt en maatregelen', async () => {
    const d = await getDashboard(p, eigenaar.userId, org);
    const shop = d.assets.find((a) => a.label.includes('webshop.') && a.type === 'website')!;
    const detail = await getAssetDetail(p, lezer.userId, org, shop.id);
    const prof = detail.webProfiel!;
    expect(prof.kennisStand).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const php = prof.onderdelen.find((o) => o.key === 'php')!;
    expect(php).toMatchObject({ versie: '7.4.33', versieZekerheid: 'zeker', status: 'einde', wie: 'hosting' });
    expect(php.uitleg).toMatch(/geen beveiligingsupdates meer/);
    expect(prof.onderdelen.find((o) => o.key === 'jquery')).toMatchObject({ status: 'einde', wie: 'webbouwer', versieZekerheid: 'waarschijnlijk' });
    expect(prof.maatregelen.find((m) => m.key === 'hsts')).toMatchObject({ ok: false });
    expect(prof.hosting).toMatchObject({ naam: 'Hetzner', soort: 'cloud', zekerheid: 'waarschijnlijk' });
    // Het profiel is geen los kenmerk in de lijst.
    expect(detail.attributes.some((a) => a.key === 'web.profiel')).toBe(false);
    const www = d.assets.find((a) => a.label === 'www.voorbeeldbedrijf.example' || a.label.startsWith('https://www.'))!;
    const wp = (await getAssetDetail(p, eigenaar.userId, org, www.id)).webProfiel!.onderdelen;
    expect(wp.find((o) => o.key === 'wordpress')).toMatchObject({ versie: '6.8.2', versieZekerheid: 'waarschijnlijk', status: 'achter' });
    expect(wp.filter((o) => o.categorie === 'plugin').map((o) => o.naam).sort()).toEqual(['Contact Form 7', 'Elementor', 'WooCommerce']);
  });

  it('een lezer mag kijken maar geen voorbeelddata vullen; een buitenstaander ziet niets', async () => {
    await expect(getDashboard(p, lezer.userId, org)).resolves.toBeTruthy();
    await expect(seedDemoData(p, lezer, org)).rejects.toMatchObject({ code: 'geen_toegang' });
    await expect(getDashboard(p, vreemde.userId, org)).rejects.toMatchObject({ code: 'niet_gevonden' });
    const d = await getDashboard(p, eigenaar.userId, org);
    await expect(getAssetDetail(p, vreemde.userId, org, d.assets[0]!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
  });

  it('bevinding die alleen het platform kan veranderen: geen actie, ter info, één regel per platform', async () => {
    const d0 = await getDashboard(p, eigenaar.userId, org);
    const site = d0.assets.find((a) => a.type === 'website')!;
    await p.pool.query(
      `INSERT INTO finding (asset_id, check_key, finding_key, fingerprint, certainty, title, detail, first_seen, last_seen, owner, platform)
       VALUES ($1, 'web.headers', 'web.csp_missing', 'fp-wix-csp', 'vastgesteld', 'Geen Content-Security-Policy', '', now(), now(), 'platform', 'Wix')`,
      [site.id],
    );
    const d = await getDashboard(p, eigenaar.userId, org);
    expect(d.platforms).toEqual([{ naam: 'Wix', findingCount: 1, assets: [{ id: site.id, label: site.label }] }]);
    expect(d.urgency).toBe(d0.urgency);
    const f = (await getAssetDetail(p, eigenaar.userId, org, site.id)).open.find((x) => x.title === 'Geen Content-Security-Policy' && x.platform === 'Wix')!;
    expect(f).toMatchObject({ level: 'info', action: { forWho: 'platform' } });
    await p.pool.query(`DELETE FROM finding WHERE fingerprint = 'fp-wix-csp'`);
  });

  it('voorbeelddata staat uit zonder QBICLE_DEMODATA', async () => {
    delete process.env.QBICLE_DEMODATA;
    await expect(seedDemoData(p, eigenaar, org)).rejects.toMatchObject({ code: 'geen_toegang' });
    process.env.QBICLE_DEMODATA = 'aan';
  });
});
