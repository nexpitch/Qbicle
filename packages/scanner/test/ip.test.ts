import { describe, expect, it } from 'vitest';
import { isPublicIp } from '../src/ip.ts';

describe('isPublicIp', () => {
  it.each(['8.8.8.8', '1.1.1.1', '185.15.59.224', '203.0.114.1', '2a00:1450:400e:80e::200e', '2606:4700::6810:84e5'])(
    '%s is publiek',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.5',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '64:ff9b::a00:1',
    'geen-ip',
  ])('%s is niet publiek', (ip) => expect(isPublicIp(ip)).toBe(false));
  it('IPv4-mapped publiek adres is publiek', () => expect(isPublicIp('::ffff:8.8.8.8')).toBe(true));
});
