import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  MemorySecretStore,
  PgSecretStore,
  Secret,
  SecretBox,
  keyRingFromEnv,
  looksPersonal,
  maskHostname,
  minimizeClient,
  newSecretKey,
  openCredentials,
  orgPseudonymKey,
  sealCredentials,
} from '../src/index.ts';

const ctx = { organizationId: 'org-1', sourceId: 'bron-1' };

describe('geheimen', () => {
  it('laat een Secret nooit zien in logs, JSON of tekst', () => {
    const s = new Secret('hunter2-router');
    const creds = { kind: 'wachtwoord', username: 'qbicle', password: s };
    expect(String(s)).toBe('[geheim]');
    expect(`${s}`).toBe('[geheim]');
    expect(JSON.stringify(creds)).not.toContain('hunter2');
    expect(inspect(creds, { depth: 5 })).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2-router');
  });

  it('versleutelt met AES-256-GCM, gebonden aan organisatie en bron', () => {
    const box = new SecretBox(keyRingFromEnv(`k1:${newSecretKey()}`));
    const sealed = box.seal('api-sleutel-123', ctx);
    expect(sealed).toMatch(/^v1\.k1\./);
    expect(sealed).not.toContain('api-sleutel-123');
    expect(box.open(sealed, ctx)).toBe('api-sleutel-123');
    expect(() => box.open(sealed, { ...ctx, sourceId: 'andere-bron' })).toThrow(/ontsleuteld/);
    expect(() => box.open(sealed, { ...ctx, organizationId: 'andere-klant' })).toThrow(/ontsleuteld/);
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => box.open(tampered, ctx)).toThrow();
  });

  it('kan oude geheimen lezen na een sleutelwissel en meldt dat ze opnieuw moeten', () => {
    const oud = newSecretKey();
    const sealed = new SecretBox(keyRingFromEnv(`2025:${oud}`)).seal('x', ctx);
    const box = new SecretBox(keyRingFromEnv(`2026:${newSecretKey()},2025:${oud}`));
    expect(box.open(sealed, ctx)).toBe('x');
    expect(box.needsRotation(sealed)).toBe(true);
    expect(box.needsRotation(box.seal('x', ctx))).toBe(false);
  });

  it('weigert een sleutelring met een te korte sleutel', () => {
    expect(() => keyRingFromEnv('k1:' + Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => keyRingFromEnv('')).toThrow(/QBICLE_SECRETS_KEYS/);
  });

  it('slaat inloggegevens alleen versleuteld op', async () => {
    const box = new SecretBox(keyRingFromEnv(`k1:${newSecretKey()}`));
    const store = new MemorySecretStore();
    await store.put(ctx, sealCredentials(box, { kind: 'wachtwoord', username: 'qbicle', password: new Secret('Router!Pass') }, ctx));
    expect(store.raw().join()).not.toContain('Router!Pass');
    const back = openCredentials(box, (await store.get(ctx))!, ctx);
    expect(back.kind === 'wachtwoord' && back.password.reveal()).toBe('Router!Pass');
  });
});

describe('AVG: minimalisatie', () => {
  it('herkent hostnamen met een naam', () => {
    for (const h of ['LAPTOP-ERIK', 'iPhone-van-Sanne', "Pieter's MacBook", 'Annes-MacBook-Pro', 'jan.local']) expect(looksPersonal(h)).toBe(true);
    for (const h of ['DESKTOP-7H3K2LQ', 'BRN001BA9AABBCC', 'iPhone', 'Galaxy-S23', 'shelly1pm-A1B2C3', 'Sonos-Kantoor', 'EASEE-EH123456', 'DiskStation']) {
      expect(looksPersonal(h)).toBe(false);
    }
  });

  it('maskeert de naam en laat de rest staan', () => {
    expect(maskHostname('iPhone-van-Sanne')).toBe('iPhone-van-…');
    expect(maskHostname('LAPTOP-ERIK')).toBe('LAPTOP-…');
    expect(maskHostname("Pieter's MacBook")).toBe('… MacBook');
  });

  const policy = { dropPersonalHostnames: true, pseudonymizeGuests: true, pseudonymKey: orgPseudonymKey('org-1', Buffer.alloc(32, 1).toString('base64')) };

  it('bewaart geen hostname met een naam, wel de MAC van een eigen apparaat', () => {
    expect(minimizeClient({ mac: 'A4:C3:F0:11:22:33', hostname: 'LAPTOP-ERIK' }, policy)).toEqual({ mac: 'a4:c3:f0:11:22:33', displayName: 'LAPTOP-…' });
  });

  it('pseudonimiseert gastapparaten en laat privacy-MAC\'s helemaal weg', () => {
    const vast = minimizeClient({ mac: '3C:22:FB:99:88:77', hostname: 'Pieters-MacBook', guest: true }, policy);
    expect(vast.mac).toBeUndefined();
    expect(vast.macHash).toMatch(/^[0-9a-f]{32}$/);
    expect(vast.hostname).toBeUndefined();
    expect(minimizeClient({ mac: '6E:01:02:03:04:05', hostname: 'Galaxy-S23', guest: true }, policy)).toEqual({ displayName: 'Galaxy-S23' });
  });

  it('geeft per organisatie een ander pseudoniem voor hetzelfde apparaat', () => {
    const other = { ...policy, pseudonymKey: orgPseudonymKey('org-2', Buffer.alloc(32, 1).toString('base64')) };
    const a = minimizeClient({ mac: '3C:22:FB:99:88:77', guest: true }, policy).macHash;
    expect(minimizeClient({ mac: '3c:22:fb:99:88:77', guest: true }, policy).macHash).toBe(a);
    expect(minimizeClient({ mac: '3c:22:fb:99:88:77', guest: true }, other).macHash).not.toBe(a);
  });

  it('weigert te pseudonimiseren zonder sleutel', () => {
    expect(() => minimizeClient({ mac: '3c:22:fb:99:88:77', guest: true }, { dropPersonalHostnames: true, pseudonymizeGuests: true })).toThrow(/sleutel/);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
describe.skipIf(!DATABASE_URL)('geheimen in PostgreSQL', () => {
  it('slaat alleen versleuteld op en alleen voor een bron van dezelfde organisatie', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const org = (await client.query("INSERT INTO organization (name, kind) VALUES ('Test BV', 'klant') RETURNING id")).rows[0].id as string;
      const other = (await client.query("INSERT INTO organization (name, kind) VALUES ('Ander BV', 'klant') RETURNING id")).rows[0].id as string;
      const src = (await client.query("INSERT INTO source (organization_id, kind, product, level) VALUES ($1, 'netwerk', 'unifi', '1C') RETURNING id", [org])).rows[0].id as string;
      const box = new SecretBox(keyRingFromEnv(`k1:${newSecretKey()}`));
      const store = new PgSecretStore(client);
      const c = { organizationId: org, sourceId: src };
      await store.put(c, sealCredentials(box, { kind: 'api-key', apiKey: new Secret('unifi-key-abc') }, c));
      const raw = await client.query('SELECT sealed FROM source_secret WHERE source_id = $1', [src]);
      expect(raw.rows[0].sealed).not.toContain('unifi-key-abc');
      const back = openCredentials(box, (await store.get(c))!, c);
      expect(back.kind === 'api-key' && back.apiKey.reveal()).toBe('unifi-key-abc');
      await expect(store.put({ organizationId: other, sourceId: src }, 'v1.x.y.z.w')).rejects.toThrow(/organisatie/);
      expect(await store.get({ organizationId: other, sourceId: src })).toBeUndefined();
      await expect(client.query("INSERT INTO source_secret (source_id, organization_id, sealed) VALUES ($1, $2, 'platte tekst')", [src, org])).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
