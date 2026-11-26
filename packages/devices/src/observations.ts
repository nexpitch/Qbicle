import type { Category, Identifier, Observation, Source } from '@qbicle/inventory';
import { classifyClient, type Classification } from './classify.ts';
import type { OuiDb } from './oui.ts';
import { minimizeClient, maskHostname, type PrivacyPolicy } from './privacy.ts';
import type { NetworkDevice, Readout } from './types.ts';

const ROLE_CATEGORY: Record<NetworkDevice['role'], Category> = {
  router: 'router',
  gateway: 'router',
  firewall: 'firewall',
  accesspoint: 'accesspoint',
  switch: 'switch',
};

export interface ToObservationsOptions {
  source: Source;
  oui: OuiDb;
  privacy: PrivacyPolicy;
}

export interface ClassifiedClient {
  /** Identifiers na privacyregels (zoals ze in de inventaris komen). */
  identifiers: Identifier[];
  displayName?: string;
  classification: Classification;
}

export interface DeviceObservations {
  observations: Observation[];
  /** Per client de indeling met redenen, voor uitleg in het portaal en tests. */
  clients: ClassifiedClient[];
}

/**
 * Vertaalt een uitlezing naar waarnemingen voor het assetmodel (packages/inventory).
 *
 * - Het netwerkapparaat zelf: "vastgesteld", met model en firmware.
 * - Het WAN-adres: blootstelling "internet", wordt een doel voor de buitenkant-checks.
 * - Elke client: wat de router meldt ("vastgesteld"), en in `inferred`
 *   apart de herkenning met categorie en fabrikant uit de MAC-prefix ("mogelijk").
 *   Zo blijft zichtbaar wat de router zei en wat Qbicle afleidde.
 */
export function readoutToObservations(readout: Readout, opts: ToObservationsOptions): DeviceObservations {
  const { source, oui, privacy } = opts;
  const at = readout.readAt;
  const observations: Observation[] = [];
  const clients: ClassifiedClient[] = [];

  for (const d of readout.devices) {
    const identifiers: Identifier[] = [];
    if (d.serial) identifiers.push({ type: 'serial', value: d.serial });
    if (d.mac) identifiers.push({ type: 'mac', value: d.mac });
    if (d.ip) identifiers.push({ type: 'ip', value: d.ip });
    if (identifiers.length === 0) identifiers.push({ type: 'cloud-id', value: `${source.id}:${d.role}:${d.model ?? 'onbekend'}` });
    observations.push({
      source,
      observedAt: at,
      identifiers,
      attributes: {
        kind: 'netwerkapparaat',
        category: ROLE_CATEGORY[d.role],
        exposure: 'intern',
        name: d.name ?? [d.vendor, d.model].filter(Boolean).join(' '),
        vendor: d.vendor,
        model: d.model,
        os: d.firmwareProduct,
        firmware: d.firmware,
        updateAvailable: d.updateAvailable,
      },
    });
  }

  for (const ip of readout.wanIps) {
    observations.push({
      source,
      observedAt: at,
      identifiers: [{ type: 'ip', value: ip }],
      attributes: { kind: 'ip-adres', exposure: 'internet', name: `Internetadres ${source.network ?? source.id}` },
    });
  }

  for (const c of readout.clients) {
    // Eerst indelen op de ruwe gegevens (alleen in het geheugen), dan pas minimaliseren.
    const classification = classifyClient(c, oui);
    const min = minimizeClient(c, privacy);
    const identifiers: Identifier[] = [];
    if (min.mac) identifiers.push({ type: 'mac', value: min.mac });
    if (min.macHash) identifiers.push({ type: 'mac-hash', value: min.macHash });
    if (min.hostname) identifiers.push({ type: 'hostname', value: min.hostname });
    if (c.ip) identifiers.push({ type: 'ip', value: c.ip });
    if (identifiers.length === 0) continue; // Niets om het apparaat aan te herkennen.

    // Redenen mogen de ruwe hostnaam niet bevatten als die is weggelaten.
    if (c.hostname && min.displayName !== c.hostname) {
      classification.reasons = classification.reasons.map((r) => r.split(c.hostname!).join(maskHostname(c.hostname!)));
    }
    clients.push({ identifiers, displayName: min.displayName, classification });

    const inferred: Observation['inferred'] = {
      ...(classification.category !== 'onbekend' ? { category: classification.category } : {}),
      ...(classification.vendorSource === 'mac-prefix' ? { vendor: classification.vendor } : {}),
      ...(c.services?.length ? { services: c.services } : {}),
    };
    observations.push({
      source,
      observedAt: c.lastSeen ?? at,
      identifiers,
      attributes: {
        kind: 'apparaat',
        exposure: 'intern',
        name: min.displayName,
        vendor: c.vendor,
        model: c.model,
        guest: c.guest,
      },
      ...(Object.keys(inferred).length ? { inferred } : {}),
    });
  }
  return { observations, clients };
}
