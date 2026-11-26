import type { Certainty } from '@qbicle/score';
import { inferCategory } from './classify.ts';
import { SINGLE_VALUED, identifierKey, isPrivateIpv4, normalizeIdentifier, strengthOf } from './identifiers.ts';
import type {
  AssetKind,
  AttributeKey,
  Attributes,
  Exposure,
  Identifier,
  InventoryAsset,
  Managed,
  Observation,
  Provenanced,
  ProvenancedAttributes,
  SourceKind,
} from './types.ts';

/**
 * Prioriteit per soort bron bij conflicterende kenmerken. Hoger wint.
 * Beheertools weten het best wat er op een apparaat staat; afleidingen het minst.
 */
export const SOURCE_PRIORITY: Record<SourceKind, number> = {
  mdm: 90,
  rmm: 85,
  identity: 80,
  cloud: 75,
  opgegeven: 70,
  netwerk: 60,
  connector: 50,
  scanner: 50,
  internetdata: 40,
  afleiding: 30,
};

const CERTAINTY_RANK: Record<Certainty, number> = { vastgesteld: 3, opgegeven: 3, mogelijk: 2, onbekend: 1 };
const EXPOSURE_RANK: Record<Exposure, number> = { internet: 3, cloud: 2, intern: 1, onbekend: 0 };
const END_USER = new Set(['laptop', 'desktop', 'telefoon', 'tablet']);

export interface InventoryOptions {
  now: Date;
  /** Zwakke identifiers (hostnaam + IP) voegen alleen samen binnen dit venster. Standaard 24 uur. */
  weakWindowMs?: number;
  /** Na zoveel dagen niet gezien heet een asset "verdwenen". Standaard 30. */
  goneAfterDays?: number;
}

interface Prepared {
  obs: Observation;
  ids: Identifier[];
  t: number;
}

/** Union-find over waarnemingen, met bewaking dat serienummers niet botsen. */
class Groups {
  private parent: number[];
  private serials: Array<Set<string>>;

  constructor(items: Prepared[]) {
    this.parent = items.map((_, i) => i);
    this.serials = items.map((p) => new Set(p.ids.filter((id) => SINGLE_VALUED.has(id.type)).map(identifierKey)));
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }

  /** Voegt samen tenzij beide groepen een (verschillend) serienummer hebben. */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    const sa = this.serials[ra]!;
    const sb = this.serials[rb]!;
    if (sa.size > 0 && sb.size > 0 && ![...sa].some((s) => sb.has(s))) return false;
    this.parent[rb] = ra;
    for (const s of sb) sa.add(s);
    return true;
  }
}

/**
 * Bouwt de inventaris uit losse waarnemingen.
 *
 * 1. Gedeelde sterke identifier (serienummer, cloud-ID, vaste MAC, FQDN, account) = zelfde asset.
 * 2. Zwakke identifiers voegen alleen samen als hostnaam én IP overeenkomen,
 *    in hetzelfde netwerk en binnen het tijdvenster.
 * 3. Nooit samenvoegen als dat twee verschillende serienummers in één asset zou zetten.
 */
export function buildInventory(observations: Observation[], opts: InventoryOptions): InventoryAsset[] {
  const weakWindow = opts.weakWindowMs ?? 24 * 3600_000;
  const goneAfter = (opts.goneAfterDays ?? 30) * 86400_000;

  const items: Prepared[] = observations.map((obs) => ({
    obs,
    ids: dedupe(obs.identifiers.map(normalizeIdentifier).filter((x): x is Identifier => x !== undefined)),
    t: Date.parse(obs.observedAt),
  }));
  const groups = new Groups(items);

  // Regel 1: sterke identifiers.
  const byStrong = new Map<string, number>();
  items.forEach((item, i) => {
    for (const id of item.ids) {
      if (strengthOf(id) !== 'sterk') continue;
      const key = identifierKey(id);
      const first = byStrong.get(key);
      if (first === undefined) byStrong.set(key, i);
      else groups.union(first, i);
    }
  });

  // Regel 2: hostnaam + IP samen, per netwerk, binnen het venster.
  const byWeak = new Map<string, number[]>();
  items.forEach((item, i) => {
    const host = item.ids.find((id) => id.type === 'hostname');
    if (!host) return;
    for (const ip of item.ids.filter((id) => id.type === 'ip')) {
      // Een privé-IP betekent alleen iets binnen één netwerk.
      const scope = isPrivateIpv4(ip.value) ? (item.obs.source.network ?? item.obs.source.id) : 'publiek';
      const key = `${scope}|${host.value}|${ip.value}`;
      const list = byWeak.get(key) ?? [];
      for (const j of list) if (Math.abs(items[j]!.t - item.t) <= weakWindow) groups.union(j, i);
      list.push(i);
      byWeak.set(key, list);
    }
  });

  const clusters = new Map<number, Prepared[]>();
  items.forEach((item, i) => {
    const root = groups.find(i);
    const list = clusters.get(root) ?? [];
    list.push(item);
    clusters.set(root, list);
  });

  const hasManagementSource = observations.some((o) => o.source.kind === 'mdm' || o.source.kind === 'rmm');
  const assets = [...clusters.values()].map((cluster) => toAsset(cluster, opts.now, goneAfter, hasManagementSource));
  return assets.sort((a, b) => a.key.localeCompare(b.key));
}

function toAsset(cluster: Prepared[], now: Date, goneAfter: number, hasManagementSource: boolean): InventoryAsset {
  const identifiers = dedupe(cluster.flatMap((c) => c.ids));
  const { attributes, conflicts } = resolveAttributes(cluster.map((c) => c.obs));
  const times = cluster.map((c) => c.t);
  const lastSeenMs = Math.max(...times);

  if (!attributes.category) {
    const merged = Object.fromEntries(
      Object.entries(attributes).map(([k, v]) => [k, (v as Provenanced<unknown>).value]),
    ) as Attributes;
    const services = cluster.flatMap((c) => [...(c.obs.attributes.services ?? []), ...(c.obs.inferred?.services ?? [])]);
    const guess = inferCategory({ ...merged, services });
    if (guess) {
      attributes.category = {
        value: guess,
        sourceId: 'afleiding',
        sourceKind: 'afleiding',
        observedAt: new Date(lastSeenMs).toISOString(),
        certainty: 'mogelijk',
      };
    }
  }

  const category = attributes.category?.value ?? 'onbekend';
  const kind = attributes.kind?.value ?? defaultKind(identifiers);
  const exposure = cluster
    .map((c) => c.obs.attributes.exposure ?? 'onbekend')
    .reduce<Exposure>((best, e) => (EXPOSURE_RANK[e] > EXPOSURE_RANK[best] ? e : best), 'onbekend');

  let managed: Managed = attributes.managed?.value ?? 'onbekend';
  if (cluster.some((c) => c.obs.source.kind === 'mdm' || c.obs.source.kind === 'rmm')) managed = 'ja';
  else if (managed === 'onbekend' && hasManagementSource && END_USER.has(category)) managed = 'nee';

  return {
    key: identifierKey(primaryIdentifier(identifiers)),
    kind,
    category,
    exposure,
    managed,
    identifiers,
    attributes,
    conflicts,
    sourceIds: [...new Set(cluster.map((c) => c.obs.source.id))].sort(),
    firstSeen: new Date(Math.min(...times)).toISOString(),
    lastSeen: new Date(lastSeenMs).toISOString(),
    status: now.getTime() - lastSeenMs > goneAfter ? 'verdwenen' : 'actief',
  };
}

/** Per kenmerk wint de hoogste bronprioriteit, dan de hoogste zekerheid, dan de recentste. */
export function resolveAttributes(observations: Observation[]): {
  attributes: ProvenancedAttributes;
  conflicts: InventoryAsset['conflicts'];
} {
  const candidates = new Map<AttributeKey, Provenanced<unknown>[]>();
  const add = (attrs: Attributes, p: Omit<Provenanced<unknown>, 'value'>) => {
    for (const [k, v] of Object.entries(attrs) as Array<[AttributeKey, unknown]>) {
      if (v === undefined || k === 'services' || k === 'exposure') continue;
      const list = candidates.get(k) ?? [];
      list.push({ value: v, ...p });
      candidates.set(k, list);
    }
  };
  for (const obs of observations) {
    add(obs.attributes, { sourceId: obs.source.id, sourceKind: obs.source.kind, observedAt: obs.observedAt, certainty: obs.certainty ?? 'vastgesteld' });
    if (obs.inferred) {
      add(obs.inferred, { sourceId: `${obs.source.id}:afleiding`, sourceKind: 'afleiding', observedAt: obs.observedAt, certainty: 'mogelijk' });
    }
  }

  const attributes: Record<string, Provenanced<unknown>> = {};
  const conflicts: InventoryAsset['conflicts'] = [];
  for (const [key, list] of candidates) {
    list.sort(compareProvenance);
    const winner = list[0]!;
    attributes[key] = winner;
    for (const loser of list.slice(1)) {
      if (JSON.stringify(loser.value) !== JSON.stringify(winner.value)) conflicts.push({ key, losing: loser });
    }
  }
  return { attributes: attributes as ProvenancedAttributes, conflicts };
}

function compareProvenance(a: Provenanced<unknown>, b: Provenanced<unknown>): number {
  return (
    SOURCE_PRIORITY[b.sourceKind] - SOURCE_PRIORITY[a.sourceKind] ||
    CERTAINTY_RANK[b.certainty] - CERTAINTY_RANK[a.certainty] ||
    Date.parse(b.observedAt) - Date.parse(a.observedAt)
  );
}

const PRIMARY_ORDER = ['serial', 'cloud-id', 'upn', 'fqdn', 'url', 'cert', 'mac', 'mac-hash', 'hostname', 'ip'] as const;

function primaryIdentifier(ids: Identifier[]): Identifier {
  for (const type of PRIMARY_ORDER) {
    const matches = ids.filter((id) => id.type === type && strengthOf(id) === 'sterk').sort(byValue);
    if (matches[0]) return matches[0];
  }
  return [...ids].sort(byValue)[0] ?? { type: 'hostname', value: 'onbekend' };
}

function defaultKind(ids: Identifier[]): AssetKind {
  if (ids.some((id) => id.type === 'upn')) return 'account';
  if (ids.some((id) => id.type === 'url')) return 'website';
  if (ids.some((id) => id.type === 'fqdn')) return 'domein';
  if (ids.some((id) => id.type === 'mac' || id.type === 'mac-hash' || id.type === 'serial')) return 'apparaat';
  if (ids.every((id) => id.type === 'ip')) return 'ip-adres';
  return 'apparaat';
}

function byValue(a: Identifier, b: Identifier): number {
  return a.value.localeCompare(b.value);
}

function dedupe(ids: Identifier[]): Identifier[] {
  const seen = new Map<string, Identifier>();
  for (const id of ids) seen.set(identifierKey(id), id);
  return [...seen.values()];
}
