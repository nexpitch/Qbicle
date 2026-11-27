import { SecretBox } from '@qbicle/devices';
import { SYSTEM_ACTOR } from '@qbicle/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatform, hasDb, type TestPlatform } from '../../../packages/platform/test/support/db.ts';
import { createCockpit, ipAllowed } from '../src/app.tsx';
import { addStaff, DEFAULT_COCKPIT_CONFIG, requestStaffLink, type Cockpit } from '../src/core/staff.ts';

describe('IP-toegang tot de cockpit', () => {
  it('kent exacte adressen en IPv4-reeksen', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::1'])).toBe(true);
    expect(ipAllowed(null, ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/99'])).toBe(false);
  });
});

describe.skipIf(!hasDb)('cockpit-beveiliging (S1, S2)', () => {
  let p: TestPlatform;
  let cockpit: Cockpit;
  const ORIGIN = 'https://cockpit.qbicle.test';
  beforeAll(async () => {
    p = await createTestPlatform();
    cockpit = { p, config: { ...DEFAULT_COCKPIT_CONFIG, origin: ORIGIN }, box: new SecretBox({ currentId: 't', keys: new Map([['t', Buffer.alloc(32, 7)]]) }) };
    await addStaff(cockpit, 'erik@qbicle.test', 'beheerder', { ...SYSTEM_ACTOR, kind: 'medewerker' });
  });
  afterAll(async () => p?.close());

  it('S1: een ander kan je niet buitensluiten door links voor jouw adres aan te vragen', async () => {
    const attacker = { userId: null, ip: '198.51.100.9' };
    for (let i = 0; i < 5; i++) await requestStaffLink(cockpit, 'erik@qbicle.test', attacker);
    await expect(requestStaffLink(cockpit, 'erik@qbicle.test', attacker)).rejects.toMatchObject({ code: 'te_veel_verzoeken' });
    const before = p.mailer.sent.length;
    await requestStaffLink(cockpit, 'erik@qbicle.test', { userId: null, ip: '203.0.113.7' });
    expect(p.mailer.sent.length).toBe(before + 1);
  });

  it('S2: achter de proxy telt het adres dat de eigen proxy toevoegt, en de toegangslijst gebruikt dat', async () => {
    const app = createCockpit(cockpit, { secureCookies: true, trustProxy: true, allowIps: ['203.0.113.0/24'] });
    // De bezoeker zet zelf een toegestaan adres vooraan; de proxy voegt het echte adres achteraan toe.
    const spoofed = await app.request('/inloggen', { headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.9' } });
    expect(spoofed.status).toBe(404);
    const ok = await app.request('/inloggen', { headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' } });
    expect(ok.status).toBe(200);
  });
});
