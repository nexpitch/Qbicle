import type { Observation, Source } from '../src/index.ts';

export const NOW = new Date('2026-11-26T12:00:00Z');

export const intune: Source = { id: 'intune', kind: 'mdm', product: 'intune', level: '1C' };
export const entra: Source = { id: 'entra', kind: 'identity', product: 'entra', level: '1C' };
export const unifi: Source = { id: 'unifi-utrecht', kind: 'netwerk', product: 'unifi', level: '1C', network: 'utrecht' };
export const connector: Source = { id: 'connector-utrecht', kind: 'connector', product: 'qbicle-connector', level: '2P', network: 'utrecht' };
export const fritz: Source = { id: 'fritz-amersfoort', kind: 'netwerk', product: 'fritzbox', level: '1C', network: 'amersfoort' };

/** Eén laptop zoals Intune, Entra en UniFi hem elk anders melden. */
export const laptopViaDrieBronnen: Observation[] = [
  {
    source: intune,
    observedAt: '2026-11-26T08:00:00Z',
    identifiers: [
      { type: 'serial', value: 'pf3abc12' },
      { type: 'cloud-id', value: 'INTUNE-0001' },
      { type: 'cloud-id', value: 'entra-dev-0001' },
      { type: 'mac', value: '3C-22-FB-12-34-56' },
      { type: 'hostname', value: 'LAPTOP-ERIK' },
    ],
    attributes: {
      kind: 'apparaat',
      category: 'laptop',
      exposure: 'intern',
      name: 'LAPTOP-ERIK',
      os: 'Windows 11',
      osVersion: '10.0.22631',
      lastPatched: '2026-11-20T00:00:00Z',
    },
  },
  {
    source: entra,
    observedAt: '2026-11-26T09:00:00Z',
    identifiers: [
      { type: 'cloud-id', value: 'entra-dev-0001' },
      { type: 'hostname', value: 'LAPTOP-ERIK' },
    ],
    attributes: { os: 'Windows', osVersion: '10.0.22621' },
  },
  {
    source: unifi,
    observedAt: '2026-11-26T10:00:00Z',
    identifiers: [
      { type: 'mac', value: '3c:22:fb:12:34:56' },
      { type: 'ip', value: '192.168.1.23' },
      { type: 'hostname', value: 'laptop-erik' },
    ],
    attributes: { vendor: 'Intel', exposure: 'intern' },
  },
];

/** Een printer: UniFi kent MAC en IP, de connector hoort de mDNS-aankondiging. */
export const printer: Observation[] = [
  {
    source: unifi,
    observedAt: '2026-11-26T10:00:00Z',
    identifiers: [
      { type: 'mac', value: '00:1b:a9:aa:bb:cc' },
      { type: 'ip', value: '192.168.1.40' },
      { type: 'hostname', value: 'BRN001BA9AABBCC' },
    ],
    attributes: { vendor: 'Brother', exposure: 'intern' },
  },
  {
    source: connector,
    observedAt: '2026-11-26T11:00:00Z',
    identifiers: [
      { type: 'hostname', value: 'brn001ba9aabbcc.local.' },
      { type: 'ip', value: '192.168.1.40' },
    ],
    attributes: { services: ['_ipp._tcp', '_http._tcp'], exposure: 'intern' },
  },
];
