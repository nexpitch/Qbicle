import { Secret } from '../secrets.ts';
import { HttpTransport, type Transport } from '../transport.ts';
import type { ConnectorConfig, RouterConnector } from '../types.ts';
import { FritzboxConnector } from './fritzbox.ts';
import { MikrotikConnector } from './mikrotik.ts';
import { UnifiConnector } from './unifi.ts';
import { MerakiConnector } from './meraki.ts';

export { UnifiConnector, UNIFI_RULES } from './unifi.ts';
export { MerakiConnector, MERAKI_RULES } from './meraki.ts';
export { FritzboxConnector, FRITZ_RULES, fritzOsVersion } from './fritzbox.ts';
export { MikrotikConnector, MIKROTIK_RULES, lastSeenFrom, expandPorts } from './mikrotik.ts';

/** "Bearer <sleutel>" als Secret, zodat ook de header nooit in een log belandt. */
class BearerSecret extends Secret {
  constructor(key: Secret) {
    super(`Bearer ${key.reveal()}`);
  }
}

/** Echte transport voor een configuratie (inloggegevens zitten als Secret in de headers of auth). */
export function transportFor(config: ConnectorConfig): Transport {
  const common = { baseUrl: config.baseUrl, tls: config.tls, timeoutMs: config.timeoutMs };
  const c = config.credentials;
  switch (config.product) {
    case 'unifi':
      if (c.kind !== 'api-key') throw new Error('UniFi gebruikt een API-sleutel');
      return new HttpTransport({ ...common, headers: { 'X-API-KEY': c.apiKey, Accept: 'application/json' } });
    case 'meraki':
      if (c.kind !== 'api-key') throw new Error('Meraki gebruikt een API-sleutel');
      return new HttpTransport({ ...common, headers: { Authorization: new BearerSecret(c.apiKey), Accept: 'application/json' } });
    case 'fritzbox':
      if (c.kind !== 'wachtwoord') throw new Error('FRITZ!Box gebruikt gebruikersnaam en wachtwoord');
      return new HttpTransport({ ...common, auth: { scheme: 'digest', username: c.username, password: c.password } });
    case 'mikrotik':
      if (c.kind !== 'wachtwoord') throw new Error('MikroTik gebruikt gebruikersnaam en wachtwoord');
      return new HttpTransport({ ...common, auth: { scheme: 'basic', username: c.username, password: c.password } });
  }
}

/** Maakt de connector; geef een eigen transport mee voor tests of demo's. */
export function createConnector(
  config: ConnectorConfig,
  transport: Transport = transportFor(config),
  opts: { now?: () => Date } = {},
): RouterConnector {
  switch (config.product) {
    case 'unifi':
      return new UnifiConnector(transport, { site: config.site, now: opts.now });
    case 'meraki':
      return new MerakiConnector(transport, { organizationId: config.site, now: opts.now });
    case 'fritzbox':
      return new FritzboxConnector(transport, opts);
    case 'mikrotik':
      return new MikrotikConnector(transport, opts);
  }
}
export { TableConnector, parseTable, mergeClients, type TableFormat, type TableInput } from './tables.ts';
export { SnmpConnector, FixtureSnmpSession, OID, SNMP_ALLOWED, vendorFrom, firmwareFrom, type SnmpSession, type SnmpVarbind, type SnmpCredentials } from './snmp.ts';
export { UpnpIgdConnector, UPNP_RULES } from './upnp.ts';
export { locateIgd, parseSsdpLocation, mSearch, IGD_TARGETS } from './ssdp.ts';
export { isPrivateIpv4 } from './util.ts';
