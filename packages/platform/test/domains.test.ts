import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDomain,
  confirmEmailVerification,
  createOrganization,
  extractToken,
  getDomain,
  isHostVerifiedFor,
  listDomains,
  acceptInvitation,
  domainImpact,
  inviteMember,
  removeDomain,
  renameDomain,
  requestScan,
  reverifyDomains,
  startEmailVerification,
  verifyDomainByDns,
} from '../src/index.ts';
import { createTestPlatform, hasDb, type TestPlatform } from './support/db.ts';
import { loginAs } from './support/users.ts';

type U = Awaited<ReturnType<typeof loginAs>>;

describe.skipIf(!hasDb)('domeinverificatie en scans', () => {
  let p: TestPlatform;
  let anna: U;
  let kees: U;
  let org: string;
  let otherOrg: string;

  beforeAll(async () => {
    p = await createTestPlatform();
    anna = await loginAs(p, 'anna@bakkerij.nl');
    kees = await loginAs(p, 'kees@garage.nl');
    org = (await createOrganization(p, anna, { name: 'Bakkerij', kind: 'klant' })).id;
    otherOrg = (await createOrganization(p, kees, { name: 'Garage', kind: 'klant' })).id;
  });
  afterAll(async () => p?.close());

  it('normaliseert de invoer en geeft instructies voor het TXT-record', async () => {
    const d = await addDomain(p, anna, org, { name: 'https://www.Bakkerij-Dns.nl/contact' });
    // www. wordt het hoofddomein, zodat DNS-regel en beheeradressen kloppen.
    expect(d.name).toBe('bakkerij-dns.nl');
    expect(d.verified).toBe(false);
    expect(d.instructions.dns.name).toBe('_qbicle-verificatie.bakkerij-dns.nl');
    expect(d.instructions.dns.value).toMatch(/^qbicle-verificatie=[0-9a-f]{32}$/);
    expect(d.instructions.emailAddresses).toContain('postmaster@bakkerij-dns.nl');
    await expect(addDomain(p, anna, org, { name: 'bakkerij-dns.nl' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('weigert interne namen en IP-adressen', async () => {
    await expect(addDomain(p, anna, org, { name: 'server.local' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(addDomain(p, anna, org, { name: '10.0.0.1' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
  });

  it('hetzelfde domein kan niet twee keer in één organisatie', async () => {
    await addDomain(p, anna, org, { name: 'dubbel.nl' });
    await expect(addDomain(p, anna, org, { name: 'DUBBEL.nl' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('zonder verificatie geen scan', async () => {
    const d = await addDomain(p, anna, org, { name: 'nogniet.nl' });
    await expect(requestScan(p, anna, org, d.id)).rejects.toMatchObject({ code: 'niet_geverifieerd' });
  });

  it('verificatie via DNS-TXT; daarna kan er gescand worden', async () => {
    const d = await addDomain(p, anna, org, { name: 'bakkerij.nl' });

    const fail = await verifyDomainByDns(p, anna, org, d.id);
    expect(fail.verified).toBe(false);

    // Verkeerde code: niet goed.
    p.dns.set('_qbicle-verificatie.bakkerij.nl', ['qbicle-verificatie=00000000000000000000000000000000']);
    expect((await verifyDomainByDns(p, anna, org, d.id)).verified).toBe(false);

    p.dns.set('_qbicle-verificatie.bakkerij.nl', ['v=spf1 -all', d.instructions.dns.value]);
    const ok = await verifyDomainByDns(p, anna, org, d.id);
    expect(ok.verified).toBe(true);
    expect(ok.domain.verificationMethod).toBe('dns-txt');

    const scan = await requestScan(p, anna, org, d.id);
    expect(scan.status).toBe('wachtrij');
    // Een tweede verzoek terwijl er een in de wachtrij staat geeft dezelfde scan.
    expect((await requestScan(p, anna, org, d.id)).id).toBe(scan.id);

    expect(await isHostVerifiedFor(p, org, 'www.bakkerij.nl')).toBe(true);
    expect(await isHostVerifiedFor(p, org, 'nepbakkerij.nl')).toBe(false);
    expect(await isHostVerifiedFor(p, otherOrg, 'bakkerij.nl')).toBe(false);
  });

  it('het TXT-record mag ook op het domein zelf staan', async () => {
    const d = await addDomain(p, anna, org, { name: 'apex.nl' });
    p.dns.set('apex.nl', [d.instructions.dns.value]);
    expect((await verifyDomainByDns(p, anna, org, d.id)).verified).toBe(true);
  });

  it('een DNS-fout telt nooit als geslaagd', async () => {
    const d = await addDomain(p, anna, org, { name: 'storing.nl' });
    p.dns.fail.add('_qbicle-verificatie.storing.nl');
    p.dns.fail.add('storing.nl');
    expect((await verifyDomainByDns(p, anna, org, d.id)).verified).toBe(false);
  });

  it('de code van een andere organisatie werkt niet', async () => {
    const mine = await addDomain(p, anna, org, { name: 'gedeeld.nl' });
    const theirs = await addDomain(p, kees, otherOrg, { name: 'gedeeld.nl' });
    p.dns.set('_qbicle-verificatie.gedeeld.nl', [mine.instructions.dns.value]);
    expect((await verifyDomainByDns(p, kees, otherOrg, theirs.id)).verified).toBe(false);
    expect((await verifyDomainByDns(p, anna, org, mine.id)).verified).toBe(true);
  });

  it('verificatie via een beheeradres op het domein', async () => {
    const d = await addDomain(p, anna, org, { name: 'mail-verificatie.nl' });
    await expect(startEmailVerification(p, anna, org, d.id, 'anna@gmail.com')).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(startEmailVerification(p, anna, org, d.id, 'info@sub.mail-verificatie.nl')).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(startEmailVerification(p, anna, org, d.id, 'info@mail-verificatie.nl.evil.com')).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(startEmailVerification(p, anna, org, d.id, 'geen-adres')).rejects.toMatchObject({ code: 'ongeldige_invoer' });

    await startEmailVerification(p, anna, org, d.id, 'Postmaster@mail-verificatie.nl');
    const mail = p.mailer.last('postmaster@mail-verificatie.nl')!;
    expect(mail.text).toContain('mail-verificatie.nl');
    const token = extractToken(mail.text, 'qbd_')!;

    expect(await confirmEmailVerification(p, token, { userId: null })).toEqual({ domain: 'mail-verificatie.nl' });
    await expect(confirmEmailVerification(p, token, { userId: null })).rejects.toMatchObject({ code: 'verlopen' });
    const after = await getDomain(p, anna.userId, org, d.id);
    expect(after).toMatchObject({ verified: true, verificationMethod: 'email' });
  });

  it('verificatie via een eigen adres op het domein zelf', async () => {
    const d = await addDomain(p, anna, org, { name: 'eigen-adres.nl' });
    await startEmailVerification(p, anna, org, d.id, ' Erik.de-Vries@Eigen-Adres.nl ');
    const token = extractToken(p.mailer.last('erik.de-vries@eigen-adres.nl')!.text, 'qbd_')!;
    expect(await confirmEmailVerification(p, token, { userId: null })).toEqual({ domain: 'eigen-adres.nl' });
  });

  it('geen eigen adres op een openbare maildienst', async () => {
    const d = await addDomain(p, anna, org, { name: 'gmail.com' });
    await expect(startEmailVerification(p, anna, org, d.id, 'anna@gmail.com')).rejects.toMatchObject({
      code: 'ongeldige_invoer',
      message: expect.stringMatching(/openbare maildienst/),
    });
  });

  it('een andere klant kan niets met jouw domeinen', async () => {
    const [d] = await listDomains(p, anna.userId, org);
    await expect(getDomain(p, kees.userId, org, d!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(getDomain(p, kees.userId, otherOrg, d!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(requestScan(p, kees, otherOrg, d!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(verifyDomainByDns(p, kees, otherOrg, d!.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    await expect(removeDomain(p, kees, otherOrg, d!.id, { bevestiging: d!.name })).rejects.toMatchObject({ code: 'niet_gevonden' });
  });

  it('opt-out wordt gerespecteerd, ook na verificatie', async () => {
    const d = await addDomain(p, anna, org, { name: 'nietscannen.nl' });
    p.dns.set('nietscannen.nl', [d.instructions.dns.value]);
    await verifyDomainByDns(p, anna, org, d.id);
    await p.pool.query("INSERT INTO scan_opt_out (name) VALUES ('nietscannen.nl')");
    await expect(requestScan(p, anna, org, d.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('hercontrole: verdwenen TXT-record laat de verificatie na de termijn vervallen', async () => {
    const d = await addDomain(p, anna, org, { name: 'vervalt.nl' });
    p.dns.set('vervalt.nl', [d.instructions.dns.value]);
    await verifyDomainByDns(p, anna, org, d.id);
    p.dns.set('vervalt.nl', []);

    // Net gecontroleerd: nog niets.
    await reverifyDomains(p);
    expect((await getDomain(p, anna.userId, org, d.id)).verified).toBe(true);

    // Laatste geslaagde controle langer dan 30 dagen geleden: vervalt.
    await p.pool.query("UPDATE domain SET verification_checked_at = now() - interval '31 days' WHERE id = $1", [d.id]);
    const r = await reverifyDomains(p);
    expect(r.lapsed).toBeGreaterThanOrEqual(1);
    expect((await getDomain(p, anna.userId, org, d.id)).verified).toBe(false);
    await expect(requestScan(p, anna, org, d.id)).rejects.toMatchObject({ code: 'niet_geverifieerd' });
  });

  it('beperkt het aantal DNS-controles per domein', async () => {
    const d = await addDomain(p, anna, org, { name: 'druk.nl' });
    for (let i = 0; i < 10; i++) await verifyDomainByDns(p, anna, org, d.id);
    await expect(verifyDomainByDns(p, anna, org, d.id)).rejects.toMatchObject({ code: 'te_veel_verzoeken' });
  });

  it('naam aanpassen: bevestiging vervalt, nieuwe code, assets gearchiveerd, logboek', async () => {
    const d = await addDomain(p, anna, org, { name: 'tikfuot.nl' });
    p.dns.set('_qbicle-verificatie.tikfuot.nl', [d.instructions.dns.value]);
    await verifyDomainByDns(p, anna, org, d.id);
    await p.pool.query(`INSERT INTO asset (organization_id, domain_id, type, value, source, visibility) VALUES ($1, $2, 'website', 'tikfuot.nl', 'test', 'primair')`, [org, d.id]);
    expect((await domainImpact(p, anna.userId, org, d.id)).assets).toBe(1);

    const r = await renameDomain(p, anna, org, d.id, { name: 'www.tikfout.nl' });
    expect(r.name).toBe('tikfout.nl');
    expect(r.verified).toBe(false);
    expect(r.instructions.dns.value).not.toBe(d.instructions.dns.value);
    expect((await domainImpact(p, anna.userId, org, d.id)).assets).toBe(0);
    const log = await p.pool.query(`SELECT detail FROM audit_log WHERE action = 'domein.gewijzigd' AND subject = $1`, [d.id]);
    expect(log.rows[0].detail).toMatchObject({ van: 'tikfuot.nl', naar: 'tikfout.nl', was_bevestigd: true, assets_gearchiveerd: 1 });
    await expect(renameDomain(p, anna, org, d.id, { name: 'dubbel.nl' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(renameDomain(p, anna, org, d.id, { name: 'server.local' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
  });

  it('verwijderen: alleen met de naam ingetypt, alleen eigenaar of beheerder, scans weg, assets gearchiveerd', async () => {
    const d = await addDomain(p, anna, org, { name: 'weg-ermee.nl' });
    await p.pool.query(`INSERT INTO asset (organization_id, domain_id, type, value, source, visibility) VALUES ($1, $2, 'website', 'weg-ermee.nl', 'test', 'primair')`, [org, d.id]);
    await p.pool.query(`INSERT INTO scan (domain_id, trigger) VALUES ($1, 'handmatig')`, [d.id]);
    const impact = await domainImpact(p, anna.userId, org, d.id);
    expect(impact).toMatchObject({ assets: 1, scans: 1 });

    // Een lezer mag kijken, maar niet verwijderen.
    const lex = await loginAs(p, 'lex@bakkerij.nl');
    await inviteMember(p, anna, org, { email: 'lex@bakkerij.nl', role: 'lezer' });
    await acceptInvitation(p, lex, extractToken(p.mailer.last('lex@bakkerij.nl')!.text, 'qbu_')!);
    await expect(removeDomain(p, lex, org, d.id, { bevestiging: 'weg-ermee.nl' })).rejects.toMatchObject({ code: 'geen_toegang' });

    await expect(removeDomain(p, anna, org, d.id, { bevestiging: '' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    await expect(removeDomain(p, anna, org, d.id, { bevestiging: 'weg-ermee.com' })).rejects.toMatchObject({ code: 'ongeldige_invoer' });
    const r = await removeDomain(p, anna, org, d.id, { bevestiging: ' Weg-Ermee.nl ' });
    expect(r.gearchiveerd).toBe(1);
    await expect(getDomain(p, anna.userId, org, d.id)).rejects.toMatchObject({ code: 'niet_gevonden' });
    const asset = await p.pool.query(`SELECT status, domain_id FROM asset WHERE value = 'weg-ermee.nl'`);
    expect(asset.rows[0]).toEqual({ status: 'verdwenen', domain_id: null });
    expect((await p.pool.query(`SELECT count(*)::int AS n FROM scan WHERE domain_id = $1`, [d.id])).rows[0].n).toBe(0);
    const log = await p.pool.query(`SELECT detail FROM audit_log WHERE action = 'domein.verwijderd' AND subject = $1`, [d.id]);
    expect(log.rows[0].detail).toMatchObject({ domein: 'weg-ermee.nl', assets_gearchiveerd: 1, scans_gewist: 1 });
  });
});
