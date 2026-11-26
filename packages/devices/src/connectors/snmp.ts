import { ConnectorError } from '../transport.ts';
import type { Secret } from '../secrets.ts';
import type { ClientDevice, NetworkDevice, Readout, RouterConnector } from '../types.ts';
import { isPublicIpv4 } from './util.ts';

/**
 * Generieke route via SNMP voor routers, firewalls en switches van elk merk,
 * ook oudere: alleen standaard-MIB's (SNMPv2-MIB, IP-MIB, IF-MIB), alleen lezen
 * (GET/GETNEXT/GETBULK), alleen op het ene opgegeven IP-adres.
 *
 * Let op: in het ontwerp is een SNMP-query niveau 2A (Qbicle stuurt zelf verkeer
 * naar een apparaat). Deze connector weigert daarom te werken zonder verwijzing
 * naar een getekende opdracht (consentRef), en de echte UDP-sessie
 * (SnmpSession) wordt pas aangesloten na Eriks akkoord op de scangrenzen.
 * Tot dan: interface, verwerking en tests met fixtures.
 *
 * Voorkeur: SNMPv3 met authPriv. SNMPv2c stuurt de community leesbaar over het
 * netwerk; alleen toestaan op het lokale netwerk en met een alleen-lezen community.
 */
export type SnmpValue = string | number | Buffer;

export interface SnmpVarbind {
  oid: string;
  value: SnmpValue;
}

/** Eén SNMP-doel (één IP). Alleen leesoperaties. */
export interface SnmpSession {
  get(oids: string[]): Promise<SnmpVarbind[]>;
  /** GETNEXT/GETBULK onder een tak, met een maximum aantal rijen. */
  walk(baseOid: string, maxRows: number): Promise<SnmpVarbind[]>;
}

export type SnmpCredentials =
  | { version: '3'; username: string; authProtocol: 'sha256' | 'sha512'; authKey: Secret; privProtocol: 'aes128' | 'aes256'; privKey: Secret }
  | { version: '2c'; community: Secret };

export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  /** IP-MIB ipNetToMediaPhysAddress (ARP-tabel, oud maar overal). */
  ipNetToMediaPhysAddress: '1.3.6.1.2.1.4.22.1.2',
  /** IP-MIB ipNetToPhysicalPhysAddress (nieuwer, ook IPv6). */
  ipNetToPhysicalPhysAddress: '1.3.6.1.2.1.4.35.1.4',
  /** IP-MIB ipAdEntAddr: eigen adressen (voor het WAN-adres). */
  ipAdEntAddr: '1.3.6.1.2.1.4.20.1.1',
} as const;

/** Alleen deze takken mogen gelezen worden. */
export const SNMP_ALLOWED = Object.values(OID);

/** IANA enterprise-nummers van veelvoorkomende netwerkfabrikanten (uit sysObjectID). */
const ENTERPRISES: Record<string, string> = {
  '9': 'Cisco',
  '11': 'HP',
  '2011': 'Huawei',
  '2636': 'Juniper',
  '4526': 'Netgear',
  '7367': 'DrayTek',
  '890': 'Zyxel',
  '11863': 'TP-Link',
  '12356': 'Fortinet',
  '14988': 'MikroTik',
  '41112': 'Ubiquiti',
  '8072': 'Net-SNMP (Linux)',
};

const MAX_ROWS = 5000;

export class SnmpConnector implements RouterConnector {
  readonly product = 'snmp' as const;
  private readonly session: SnmpSession;

  constructor(
    session: SnmpSession,
    private readonly opts: { consentRef: string; host: string; now?: () => Date },
  ) {
    if (!opts.consentRef) throw new ConnectorError('niet_toegestaan', 'SNMP is niveau 2A: eerst een getekende opdracht voor dit apparaat');
    this.session = guarded(session);
  }

  async read(): Promise<Readout> {
    const readAt = (this.opts.now?.() ?? new Date()).toISOString();
    const warnings: string[] = [];
    const sys = new Map((await this.session.get([OID.sysDescr, OID.sysObjectID, OID.sysName])).map((v) => [v.oid, text(v.value)]));
    const descr = sys.get(OID.sysDescr) ?? '';
    const vendor = vendorFrom(sys.get(OID.sysObjectID), descr);
    const fw = firmwareFrom(descr);

    const clients = new Map<string, ClientDevice>();
    let rows = await this.session.walk(OID.ipNetToPhysicalPhysAddress, MAX_ROWS);
    let table: 'nieuw' | 'oud' = 'nieuw';
    if (rows.length === 0) {
      rows = await this.session.walk(OID.ipNetToMediaPhysAddress, MAX_ROWS);
      table = 'oud';
    }
    if (rows.length >= MAX_ROWS) warnings.push(`ARP-tabel heeft meer dan ${MAX_ROWS} regels; de rest is niet gelezen`);
    for (const r of rows) {
      const ip = table === 'oud' ? ipFromOldIndex(r.oid) : ipFromNewIndex(r.oid);
      const m = macFrom(r.value);
      if (!ip || !m || isPublicIpv4(ip)) continue;
      clients.set(m, { ip, mac: m, active: true, lastSeen: readAt });
    }
    const own = (await this.session.walk(OID.ipAdEntAddr, 256)).map((v) => text(v.value)).filter(isPublicIpv4);

    const device: NetworkDevice = {
      role: 'router',
      vendor: vendor ?? 'onbekend',
      model: fw.model,
      name: sys.get(OID.sysName),
      ip: this.opts.host,
      firmware: fw.version,
      firmwareProduct: fw.product,
    };
    if (!fw.version) warnings.push('Firmwareversie niet uit sysDescr te halen; controleer handmatig');
    return { product: 'snmp', readAt, devices: [device], clients: [...clients.values()], wanIps: own, warnings };
  }
}

/** Laat alleen leesverzoeken binnen de toegestane takken door. */
function guarded(s: SnmpSession): SnmpSession {
  const ok = (oid: string) => SNMP_ALLOWED.some((base) => oid === base || oid.startsWith(base + '.'));
  return {
    get: (oids) => {
      if (!oids.every(ok)) throw new ConnectorError('niet_toegestaan', 'SNMP-OID niet toegestaan');
      return s.get(oids);
    },
    walk: (base, max) => {
      if (!ok(base)) throw new ConnectorError('niet_toegestaan', 'SNMP-OID niet toegestaan');
      return s.walk(base, max);
    },
  };
}

function text(v: SnmpValue): string {
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

function macFrom(v: SnmpValue): string | undefined {
  const b = Buffer.isBuffer(v) ? v : typeof v === 'string' && /^([0-9a-f]{2}[:\- ]?){6}$/i.test(v.trim()) ? Buffer.from(v.replace(/[^0-9a-f]/gi, ''), 'hex') : undefined;
  if (!b || b.length !== 6) return undefined;
  const s = [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
  return s === '00:00:00:00:00:00' || s === 'ff:ff:ff:ff:ff:ff' ? undefined : s;
}

/** ipNetToMediaPhysAddress.<ifIndex>.<a>.<b>.<c>.<d> */
function ipFromOldIndex(oid: string): string | undefined {
  const parts = oid.slice(OID.ipNetToMediaPhysAddress.length + 1).split('.');
  return parts.length === 5 ? parts.slice(1).join('.') : undefined;
}

/** ipNetToPhysicalPhysAddress.<ifIndex>.<type 1=ipv4>.<len 4>.<a>.<b>.<c>.<d> */
function ipFromNewIndex(oid: string): string | undefined {
  const parts = oid.slice(OID.ipNetToPhysicalPhysAddress.length + 1).split('.');
  return parts[1] === '1' && parts[2] === '4' && parts.length === 7 ? parts.slice(3).join('.') : undefined;
}

export function vendorFrom(sysObjectID: string | undefined, descr: string): string | undefined {
  const ent = sysObjectID?.replace(/^\.?1\.3\.6\.1\.4\.1\./, '').split('.')[0];
  if (ent && ENTERPRISES[ent]) return ENTERPRISES[ent];
  for (const name of ['MikroTik', 'Cisco', 'DrayTek', 'Zyxel', 'Fortinet', 'Juniper', 'Netgear', 'TP-Link', 'Huawei', 'Ubiquiti', 'pfSense', 'OPNsense']) {
    if (new RegExp(name, 'i').test(descr)) return name;
  }
  return undefined;
}

/** Firmware uit sysDescr, voor bekende patronen; anders het eerste versienummer. */
export function firmwareFrom(descr: string): { product?: string; version?: string; model?: string } {
  let m = descr.match(/RouterOS\s+(\S+)/i);
  if (m) return { product: 'RouterOS', version: m[1], model: descr.match(/RouterOS\s+\S+\s+(\S+)/)?.[1] };
  m = descr.match(/Cisco IOS.*Version\s+([\w.()]+)/i);
  if (m) return { product: 'Cisco IOS', version: m[1] };
  m = descr.match(/DrayTek\s+(Vigor\S*)/i);
  if (m) return { product: 'DrayOS', model: m[1], version: descr.match(/\b(\d+\.\d+(?:\.\d+)*)\b/)?.[1] };
  m = descr.match(/\b[vV]?(\d+\.\d+(?:\.\d+){0,2})\b/);
  return m ? { version: m[1] } : {};
}

/** Voor tests en de demo: een SNMP-sessie met vaste antwoorden. */
export class FixtureSnmpSession implements SnmpSession {
  readonly requests: string[] = [];
  constructor(private readonly varbinds: SnmpVarbind[]) {}
  async get(oids: string[]): Promise<SnmpVarbind[]> {
    this.requests.push(...oids.map((o) => `get ${o}`));
    return this.varbinds.filter((v) => oids.includes(v.oid));
  }
  async walk(base: string, max: number): Promise<SnmpVarbind[]> {
    this.requests.push(`walk ${base}`);
    return this.varbinds.filter((v) => v.oid.startsWith(base + '.')).slice(0, max);
  }
}
