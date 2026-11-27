import { exposureFactor } from '@qbicle/inventory';
import {
  ACTIONS,
  score,
  type Certainty,
  type Finding as ScoreFinding,
  type ForWho,
  type LinkedVuln,
  type Outcome,
  type ScoreResult,
  type Source,
  type Visibility,
} from '@qbicle/score';
import type { Platform } from './context.ts';
import { many, one } from './db.ts';
import { notFound } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';

/**
 * Het klantdashboard: alles wat de hoofdpagina van een organisatie nodig heeft,
 * in één opvraging. De urgentie rekenen we live uit met het scoremodel over de
 * open bevindingen, zodat een geaccepteerde of opgeloste bevinding direct
 * zichtbaar effect heeft. De trend rekenen we op dezelfde manier terug uit de
 * geschiedenis van bevindingen (eerst gezien, opgelost, geaccepteerd).
 */

export type Level = 'crit' | 'warn' | 'unk' | 'ok';

export type AssetGroupKey = 'domeinen' | 'websites' | 'mail' | 'servers' | 'cloud' | 'netwerk' | 'apparaten';

export const ASSET_GROUPS: { key: AssetGroupKey; label: string; types: string[]; uitleg: string }[] = [
  { key: 'domeinen', label: 'Domeinen', types: ['domein', 'subdomein'], uitleg: 'Je domeinnamen en subdomeinen' },
  { key: 'websites', label: 'Websites en certificaten', types: ['website', 'certificaat'], uitleg: 'Wat bezoekers in de browser zien' },
  { key: 'mail', label: 'E-mail', types: ['mailserver'], uitleg: 'Mailservers en mailinstellingen' },
  { key: 'servers', label: 'Servers en diensten', types: ['host', 'dienst', 'ip-adres', 'ip-blok'], uitleg: 'Systemen die vanaf internet bereikbaar zijn' },
  { key: 'cloud', label: 'Cloud en accounts', types: ['cloudresource', 'account'], uitleg: 'Clouddiensten zoals Microsoft 365' },
  { key: 'netwerk', label: 'Netwerkapparatuur', types: ['netwerkapparaat'], uitleg: 'Routers, firewalls en wifi' },
  { key: 'apparaten', label: 'Apparaten', types: ['apparaat'], uitleg: 'Laptops, printers, camera’s en meer' },
];

const GROUP_OF = new Map(ASSET_GROUPS.flatMap((g) => g.types.map((t) => [t, g.key] as const)));

export const TYPE_LABELS: Record<string, string> = {
  domein: 'Domein',
  subdomein: 'Subdomein',
  host: 'Server',
  mailserver: 'Mailserver',
  website: 'Website',
  certificaat: 'Certificaat',
  dienst: 'Dienst',
  apparaat: 'Apparaat',
  netwerkapparaat: 'Netwerkapparaat',
  'ip-adres': 'IP-adres',
  'ip-blok': 'IP-blok',
  account: 'Account',
  cloudresource: 'Clouddienst',
};

export const FOR_WHO_LABELS: Record<ForWho, string> = {
  zelf: 'Kun je zelf',
  'it-partner': 'Voor je IT-partner',
  webbouwer: 'Voor je webbouwer',
};

/** Vanaf dit gewicht (na alle factoren) is een bevinding rood. */
const CRIT_WEIGHT = 30;
const TREND_WEEKS = 12;
const CHANGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export interface DashboardAssetRef {
  id: string;
  label: string;
}

export interface DashboardAction {
  key: string;
  title: string;
  why: string;
  forWho: ForWho;
  weight: number;
  level: Level;
  findingCount: number;
  assets: DashboardAssetRef[];
}

export interface DashboardAsset {
  id: string;
  type: string;
  typeLabel: string;
  group: AssetGroupKey;
  label: string;
  level: Level;
  openFindings: number;
  exposure: string;
  lastSeen: Date;
  firstSeen: Date;
}

export interface DashboardAssetGroup {
  key: AssetGroupKey;
  label: string;
  uitleg: string;
  count: number;
  withIssues: number;
  level: Level;
}

export interface TrendPoint {
  /** Begin van de dag (UTC) waarop het punt geldt. */
  at: Date;
  urgency: number;
}

export interface ChangeItem {
  findingId: string;
  asset: DashboardAssetRef;
  title: string;
  at: Date;
}

export interface Melding {
  level: Level;
  text: string;
  href?: string;
  linkText?: string;
}

export interface ActivityItem {
  at: Date;
  text: string;
  href?: string;
}

export interface NextStep {
  title: string;
  text: string;
  href: string;
  label: string;
}

/** Wanneer de (volgende) scan komt, in gewone taal op te bouwen in de webapp. */
export interface ScanPlan {
  status: 'geen_domein' | 'niet_bevestigd' | 'bezig' | 'eerste' | 'gepland';
  /** Bij "gepland": vroegste volgende wekelijkse controle (laatste geslaagde scan + 7 dagen). */
  volgende: Date | null;
}

export const SCAN_INTERVAL_DAYS = 7;

export interface Dashboard {
  /** Er is minstens één asset of scan, dus iets om te laten zien. */
  hasData: boolean;
  urgency: number;
  band: { key: string; label: string };
  bandRaisedByKev: boolean;
  level: Level;
  /** Urgentie op het begin van de vergelijkingsperiode, of null als we toen nog niets wisten. */
  urgencyBefore: number | null;
  coverage: { pct: number; warning: string | null } | null;
  lastScanAt: Date | null;
  scanPlan: ScanPlan;
  domains: { total: number; verified: number };
  counts: {
    assets: number;
    assetsNew: number;
    openFindings: number;
    vastgesteld: number;
    mogelijk: number;
    onbekend: number;
    actions: number;
    actionsZelf: number;
    resolved: number;
    new: number;
  };
  /** Begin van "sinds vorige keer": de periode waarover opgelost en nieuw gaan. */
  since: Date;
  actions: DashboardAction[];
  groups: DashboardAssetGroup[];
  assets: DashboardAsset[];
  trend: TrendPoint[];
  resolved: ChangeItem[];
  added: ChangeItem[];
  meldingen: Melding[];
  activity: ActivityItem[];
  nextStep: NextStep;
}

interface AssetRow {
  id: string;
  type: string;
  value: string;
  visibility: Visibility | null;
  exposure: 'internet' | 'cloud' | 'intern' | 'onbekend';
  managed: 'ja' | 'nee' | 'onbekend';
  status: string;
  first_seen: Date;
  last_seen: Date;
}

interface FindingRow {
  id: string;
  asset_id: string;
  check_key: string;
  finding_key: string;
  fingerprint: string;
  certainty: Certainty;
  title: string;
  detail: string;
  sources: Source[];
  first_seen: Date;
  last_seen: Date;
  resolved_at: Date | null;
  accepted_at: Date | null;
}

interface VulnRow {
  finding_id: string;
  cve_id: string;
  euvd_id: string | null;
  cvss: string | null;
  in_kev: boolean;
  epss: string | null;
}

function assetLabel(a: Pick<AssetRow, 'type' | 'value'>): string {
  return a.type === 'website' ? a.value.replace(/^https?:\/\//, '').replace(/\/$/, '') : a.value;
}

function zFor(a: AssetRow): number {
  if (a.visibility) return { primair: 1, subdomein: 0.7, 'alleen-ct': 0.5 }[a.visibility];
  return exposureFactor(a.exposure, a.managed);
}

function vulnsOf(rows: VulnRow[]): LinkedVuln[] {
  return rows.map((v) => ({
    cveId: v.cve_id,
    cvss: v.cvss === null ? undefined : Number(v.cvss),
    inKev: v.in_kev,
    epss: v.epss === null ? undefined : Number(v.epss),
  }));
}

/** Bronnen van een bevinding: wat de scanner meegaf plus vaste bronnen per kwetsbaarheid. */
export function sourcesFor(stored: Source[], vulns: VulnRow[]): Source[] {
  const out: Source[] = [...stored];
  for (const v of vulns) {
    out.push({ name: `NVD ${v.cve_id}`, url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.cve_id)}` });
    if (v.euvd_id) out.push({ name: `EUVD ${v.euvd_id}`, url: `https://euvd.enisa.europa.eu/vulnerability/${encodeURIComponent(v.euvd_id)}` });
    if (v.in_kev) out.push({ name: 'CISA KEV (wordt actief misbruikt)', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' });
  }
  const seen = new Set<string>();
  return out.filter((s) => typeof s?.url === 'string' && /^https:\/\//.test(s.url) && !seen.has(s.url) && Boolean(seen.add(s.url)));
}

function toScoreFinding(f: FindingRow, a: AssetRow, vulns: VulnRow[]): ScoreFinding {
  return {
    key: f.finding_key,
    checkKey: f.check_key,
    asset: { type: a.type as ScoreFinding['asset']['type'], value: a.value, source: 'inventaris', visibility: a.visibility ?? 'primair' },
    certainty: f.certainty,
    title: f.title,
    detail: f.detail,
    fingerprint: f.fingerprint,
    vulns: vulnsOf(vulns),
    z: zFor(a),
  };
}

function levelFromWeight(weight: number, kev: boolean): Level {
  if (kev || weight >= CRIT_WEIGHT) return 'crit';
  return weight > 0 ? 'warn' : 'unk';
}

function worst(levels: Level[]): Level {
  for (const l of ['crit', 'warn', 'unk'] as const) if (levels.includes(l)) return l;
  return 'ok';
}

function levelForBand(band: string): Level {
  return band === 'direct' || band === 'hoog' ? 'crit' : band === 'aandacht' ? 'warn' : 'ok';
}

interface Loaded {
  assets: AssetRow[];
  findings: FindingRow[];
  vulns: Map<string, VulnRow[]>;
}

async function load(p: Platform, organizationId: string, historySince: Date): Promise<Loaded> {
  const assets = await many<AssetRow>(
    p.pool,
    `SELECT id, type, value, visibility, exposure, managed, status, first_seen, last_seen
       FROM asset WHERE organization_id = $1 ORDER BY first_seen, value`,
    [organizationId],
  );
  const findings = await many<FindingRow>(
    p.pool,
    `SELECT f.id, f.asset_id, f.check_key, f.finding_key, f.fingerprint, f.certainty, f.title, f.detail, f.sources,
            f.first_seen, f.last_seen, f.resolved_at, f.accepted_at
       FROM finding f JOIN asset a ON a.id = f.asset_id
      WHERE a.organization_id = $1 AND (f.resolved_at IS NULL OR f.resolved_at > $2)
      ORDER BY f.first_seen`,
    [organizationId, historySince],
  );
  const vulnRows = findings.length
    ? await many<VulnRow>(
        p.pool,
        `SELECT fv.finding_id, v.cve_id, v.euvd_id, v.cvss::text AS cvss, v.in_kev, v.epss::text AS epss
           FROM finding_vuln fv JOIN vuln v ON v.cve_id = fv.cve_id WHERE fv.finding_id = ANY($1::uuid[])`,
        [findings.map((f) => f.id)],
      )
    : [];
  const vulns = new Map<string, VulnRow[]>();
  for (const v of vulnRows) vulns.set(v.finding_id, [...(vulns.get(v.finding_id) ?? []), v]);
  return { assets, findings, vulns };
}

/** Open op moment t: toen al gezien, nog niet opgelost en nog niet geaccepteerd. */
function openAt(f: FindingRow, t: Date): boolean {
  return f.first_seen <= t && (!f.resolved_at || f.resolved_at > t) && (!f.accepted_at || f.accepted_at > t);
}

function scoreAt(l: Loaded, byId: Map<string, AssetRow>, t: Date | null, outcomes: Outcome[]): ScoreResult {
  const open = l.findings.filter((f) => (t ? openAt(f, t) : !f.resolved_at && !f.accepted_at));
  return score({
    findings: open.flatMap((f) => {
      const a = byId.get(f.asset_id);
      return a && a.status === 'actief' ? [toScoreFinding(f, a, l.vulns.get(f.id) ?? [])] : [];
    }),
    outcomes,
  });
}

const ACTIVITY_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  'org.aangemaakt': () => 'Organisatie aangemaakt',
  'domein.toegevoegd': (d) => `Domein ${d.domein ?? ''} toegevoegd`,
  'domein.geverifieerd': (d) => `Domein ${d.domein ?? ''} bevestigd als van jullie`,
  'domein.verwijderd': (d) => `Domein ${d.domein ?? ''} verwijderd`,
  'domein.gewijzigd': (d) => `Domein ${d.van ?? ''} gewijzigd in ${d.naar ?? ''}`,
  'domein.verificatie_vervallen': (d) => `Bevestiging van ${d.domein ?? 'een domein'} is vervallen`,
  'scan.aangevraagd': (d) => `Scan aangevraagd${d.domein ? ` voor ${d.domein}` : ''}`,
  'uitnodiging.geaccepteerd': () => 'Een nieuwe collega doet mee',
  'abonnement.gestart': () => 'Abonnement gestart',
  'abonnement.geactiveerd': () => 'Abonnement betaald en actief',
  'factuur.uitgegeven': () => 'Nieuwe factuur klaar',
  'partner.toegang_verleend': () => 'IT-partner heeft toegang gekregen',
  'bevinding.geaccepteerd': () => 'Een bevinding is geaccepteerd',
};

export async function getDashboard(p: Platform, userId: string, organizationId: string, now = new Date()): Promise<Dashboard> {
  await authorize(p.pool, userId, organizationId, 'bevindingen:lezen');
  const base = `/o/${organizationId}`;
  const trendStart = new Date(now.getTime() - TREND_WEEKS * 7 * DAY);
  const since = new Date(now.getTime() - CHANGE_DAYS * DAY);
  const l = await load(p, organizationId, trendStart);
  const byId = new Map(l.assets.map((a) => [a.id, a]));

  const domains = (await one<{ total: number; verified: number }>(
    p.pool,
    `SELECT count(*)::int AS total, count(verified_at)::int AS verified FROM domain WHERE organization_id = $1`,
    [organizationId],
  ))!;
  const scans = await many<{ id: string; domain_name: string; finished_at: Date }>(
    p.pool,
    `SELECT DISTINCT ON (s.domain_id) s.id, d.name AS domain_name, s.finished_at
       FROM scan s JOIN domain d ON d.id = s.domain_id
      WHERE d.organization_id = $1 AND s.status = 'klaar' AND s.finished_at IS NOT NULL
      ORDER BY s.domain_id, s.finished_at DESC`,
    [organizationId],
  );
  const outcomes = scans.length
    ? (await many<{ outcome: Outcome }>(p.pool, 'SELECT outcome FROM check_run WHERE scan_id = ANY($1::uuid[])', [scans.map((s) => s.id)])).map(
        (r) => r.outcome,
      )
    : [];
  const lastScanAt = scans.reduce<Date | null>((m, s) => (!m || s.finished_at > m ? s.finished_at : m), null);

  const current = scoreAt(l, byId, null, outcomes);
  const activeAssets = l.assets.filter((a) => a.status === 'actief');
  const openFindings = l.findings.filter((f) => !f.resolved_at && !f.accepted_at && byId.get(f.asset_id)?.status === 'actief');
  const byFingerprint = new Map(openFindings.map((f) => [f.fingerprint, f]));
  const contribution = new Map(current.contributions.map((c) => [c.fingerprint, c]));

  // Niveau per asset uit de bijdragen van zijn bevindingen.
  const assetLevels = new Map<string, Level[]>();
  for (const f of openFindings) {
    const c = contribution.get(f.fingerprint);
    const kev = f.certainty === 'vastgesteld' && (l.vulns.get(f.id) ?? []).some((v) => v.in_kev);
    const raw = c ? c.b * c.m * c.z * c.k : 0;
    assetLevels.set(f.asset_id, [...(assetLevels.get(f.asset_id) ?? []), levelFromWeight(raw, kev)]);
  }
  const openPerAsset = new Map<string, number>();
  for (const f of openFindings) openPerAsset.set(f.asset_id, (openPerAsset.get(f.asset_id) ?? 0) + 1);

  const order: Record<Level, number> = { crit: 0, warn: 1, unk: 2, ok: 3 };
  const assets: DashboardAsset[] = activeAssets
    .map((a) => ({
      id: a.id,
      type: a.type,
      typeLabel: TYPE_LABELS[a.type] ?? a.type,
      group: GROUP_OF.get(a.type) ?? 'servers',
      label: assetLabel(a),
      level: worst(assetLevels.get(a.id) ?? []),
      openFindings: openPerAsset.get(a.id) ?? 0,
      exposure: a.exposure,
      lastSeen: a.last_seen,
      firstSeen: a.first_seen,
    }))
    .sort((x, y) => order[x.level] - order[y.level] || y.openFindings - x.openFindings || x.label.localeCompare(y.label));

  const groups: DashboardAssetGroup[] = ASSET_GROUPS.map((g) => {
    const in_ = assets.filter((a) => a.group === g.key);
    return {
      key: g.key,
      label: g.label,
      uitleg: g.uitleg,
      count: in_.length,
      withIssues: in_.filter((a) => a.level === 'crit' || a.level === 'warn').length,
      level: worst(in_.map((a) => a.level)),
    };
  });

  // Alle acties (het scoremodel geeft er maximaal drie terug), zwaarste eerst.
  const grouped = new Map<string, { weight: number; fps: string[] }>();
  for (const c of current.contributions) {
    if (c.weight <= 0) continue;
    const g = grouped.get(c.action) ?? { weight: 0, fps: [] };
    g.weight += c.weight;
    g.fps.push(c.fingerprint);
    grouped.set(c.action, g);
  }
  const actions: DashboardAction[] = [...grouped.entries()]
    .map(([key, g]) => {
      const def = ACTIONS[key] ?? {
        title: 'Laat deze bevinding beoordelen door je IT-partner',
        why: 'We hebben iets gevonden waar nog geen vaste uitleg voor is.',
        forWho: 'it-partner' as const,
      };
      const refs = new Map<string, DashboardAssetRef>();
      let kev = false;
      for (const fp of g.fps) {
        const f = byFingerprint.get(fp);
        if (!f) continue;
        const a = byId.get(f.asset_id)!;
        refs.set(a.id, { id: a.id, label: assetLabel(a) });
        kev ||= f.certainty === 'vastgesteld' && (l.vulns.get(f.id) ?? []).some((v) => v.in_kev);
      }
      return {
        key,
        title: def.title,
        why: def.why,
        forWho: def.forWho,
        weight: Math.round(g.weight * 10) / 10,
        level: levelFromWeight(g.weight, kev),
        findingCount: g.fps.length,
        assets: [...refs.values()],
      };
    })
    .sort((x, y) => y.weight - x.weight);

  // Trend: wekelijks punt, teruggerekend uit de geschiedenis van bevindingen.
  const firstKnown = l.assets.reduce<Date | null>((m, a) => (!m || a.first_seen < m ? a.first_seen : m), null);
  const trend: TrendPoint[] = [];
  if (firstKnown) {
    for (let w = TREND_WEEKS; w >= 0; w--) {
      const t = w === 0 ? now : new Date(now.getTime() - w * 7 * DAY);
      if (t < firstKnown) continue;
      trend.push({ at: t, urgency: w === 0 ? current.urgency : scoreAt(l, byId, t, outcomes).urgency });
    }
  }
  const urgencyBefore = firstKnown && firstKnown <= since ? scoreAt(l, byId, since, outcomes).urgency : null;

  const ref = (f: FindingRow): DashboardAssetRef => {
    const a = byId.get(f.asset_id)!;
    return { id: a.id, label: assetLabel(a) };
  };
  const resolved = l.findings
    .filter((f) => f.resolved_at && f.resolved_at > since)
    .sort((x, y) => y.resolved_at!.getTime() - x.resolved_at!.getTime())
    .map((f) => ({ findingId: f.id, asset: ref(f), title: f.title, at: f.resolved_at! }));
  const added = openFindings
    .filter((f) => f.first_seen > since)
    .sort((x, y) => y.first_seen.getTime() - x.first_seen.getTime())
    .map((f) => ({ findingId: f.id, asset: ref(f), title: f.title, at: f.first_seen }));

  const counts = {
    assets: activeAssets.length,
    assetsNew: activeAssets.filter((a) => a.first_seen > since).length,
    openFindings: openFindings.length,
    vastgesteld: openFindings.filter((f) => f.certainty === 'vastgesteld' || f.certainty === 'opgegeven').length,
    mogelijk: openFindings.filter((f) => f.certainty === 'mogelijk').length,
    onbekend: openFindings.filter((f) => f.certainty === 'onbekend').length,
    actions: actions.length,
    actionsZelf: actions.filter((a) => a.forWho === 'zelf').length,
    resolved: resolved.length,
    new: added.length,
  };

  // Meldingen: wat aandacht vraagt naast de acties.
  const meldingen: Melding[] = [];
  const unverified = domains.total - domains.verified;
  if (domains.total === 0) {
    meldingen.push({ level: 'unk', text: 'Je hebt nog geen domein toegevoegd. Zonder domein kunnen we niets voor je bewaken.', href: `${base}/domeinen`, linkText: 'Domein toevoegen' });
  } else if (unverified > 0) {
    meldingen.push({
      level: 'warn',
      text: `${unverified === 1 ? 'Eén domein is' : `${unverified} domeinen zijn`} nog niet bevestigd. Pas na bevestiging scannen we ${unverified === 1 ? 'het' : 'ze'}.`,
      href: `${base}/domeinen`,
      linkText: 'Bevestigen',
    });
  }
  if (current.bandRaisedByKev) {
    meldingen.push({ level: 'crit', text: 'Er draait software met een lek dat nu actief wordt misbruikt. Pak dit vandaag op.', href: `${base}/overzicht#acties`, linkText: 'Naar de acties' });
  }
  const expiring = openFindings.filter((f) => f.finding_key === 'cert.expires_14d');
  for (const f of expiring.slice(0, 2)) {
    meldingen.push({ level: 'warn', text: `Het certificaat van ${ref(f).label} verloopt binnen 14 dagen.`, href: `${base}/assets/${f.asset_id}`, linkText: 'Bekijken' });
  }
  if (lastScanAt && current.coverageWarning) {
    meldingen.push({ level: 'unk', text: current.coverageWarning });
  }
  if (lastScanAt && now.getTime() - lastScanAt.getTime() > 14 * DAY) {
    meldingen.push({ level: 'unk', text: 'De laatste scan is meer dan twee weken oud. De cijfers kunnen achterlopen.' });
  }

  // Activiteit: logboek plus afgeronde scans, nieuwste eerst.
  const logs = await many<{ action: string; detail: Record<string, unknown> | null; at: Date }>(
    p.pool,
    `SELECT action, detail, at FROM audit_log WHERE organization_id = $1 AND action = ANY($2::text[]) ORDER BY at DESC LIMIT 12`,
    [organizationId, Object.keys(ACTIVITY_TEXT)],
  );
  const finished = await many<{ name: string; finished_at: Date }>(
    p.pool,
    `SELECT d.name, s.finished_at FROM scan s JOIN domain d ON d.id = s.domain_id
      WHERE d.organization_id = $1 AND s.status = 'klaar' AND s.finished_at IS NOT NULL ORDER BY s.finished_at DESC LIMIT 6`,
    [organizationId],
  );
  const activity: ActivityItem[] = [
    ...logs.map((r) => ({ at: r.at, text: ACTIVITY_TEXT[r.action]!(r.detail ?? {}).replace(/\s+/g, ' ').trim() })),
    ...finished.map((s) => ({ at: s.finished_at, text: `Scan van ${s.name} afgerond` })),
    ...resolved.slice(0, 4).map((r) => ({ at: r.at, text: `Opgelost: ${r.title}`, href: `${base}/assets/${r.asset.id}` })),
  ]
    .sort((x, y) => y.at.getTime() - x.at.getTime())
    .slice(0, 8);

  // Eén heldere volgende stap.
  let nextStep: NextStep;
  if (domains.total === 0) {
    nextStep = { title: 'Voeg je domein toe', text: 'Begin met het domein van je website en e-mail. Daarna zoeken we de rest erbij.', href: `${base}/domeinen`, label: 'Domein toevoegen' };
  } else if (domains.verified === 0) {
    nextStep = { title: 'Bevestig dat het domein van jullie is', text: 'Met één DNS-regel of een mail naar admin@ of postmaster@. Daarna starten we de eerste scan.', href: `${base}/domeinen`, label: 'Domein bevestigen' };
  } else if (!lastScanAt && actions.length === 0) {
    nextStep = { title: 'Je eerste scan komt eraan', text: 'We kijken naar alles wat van buitenaf zichtbaar is. Je krijgt een mail zodra het klaar is.', href: `${base}/domeinen`, label: 'Bekijk je domeinen' };
  } else if (actions[0]) {
    const a = actions[0];
    nextStep = {
      title: a.title,
      text: `${a.why} ${a.forWho === 'zelf' ? 'Dit kun je zelf doen.' : a.forWho === 'webbouwer' ? 'Stuur dit door naar je webbouwer.' : 'Stuur dit door naar je IT-partner.'}`,
      href: a.assets[0] ? `${base}/assets/${a.assets[0].id}` : `${base}/overzicht#acties`,
      label: a.assets.length === 1 ? 'Bekijk wat we zagen' : 'Bekijk de details',
    };
  } else {
    nextStep = { title: 'Alles in orde', text: 'We vonden niets dat je nu hoeft op te pakken. We blijven je systemen bewaken en melden het als er iets verandert.', href: `${base}/domeinen`, label: 'Bekijk je domeinen' };
  }

  return {
    hasData: l.assets.length > 0 || scans.length > 0,
    urgency: current.urgency,
    band: current.band,
    bandRaisedByKev: current.bandRaisedByKev,
    level: levelForBand(current.band.key),
    urgencyBefore,
    coverage: lastScanAt ? { pct: current.coverage.pct, warning: current.coverageWarning } : null,
    lastScanAt,
    scanPlan: await scanPlanFor(p, organizationId, domains),
    domains,
    counts,
    since,
    actions,
    groups,
    assets,
    trend,
    resolved,
    added,
    meldingen,
    activity,
    nextStep,
  };
}

async function scanPlanFor(p: Platform, organizationId: string, domains: { total: number; verified: number }): Promise<ScanPlan> {
  if (!domains.total) return { status: 'geen_domein', volgende: null };
  if (!domains.verified) return { status: 'niet_bevestigd', volgende: null };
  const r = (await one<{ bezig: boolean; nooit: boolean; oudste: Date | null }>(
    p.pool,
    `SELECT bool_or(s.status IN ('wachtrij', 'bezig')) AS bezig,
            bool_or(ok.last_ok IS NULL) AS nooit,
            min(ok.last_ok) AS oudste
       FROM domain d
       LEFT JOIN LATERAL (SELECT max(k.finished_at) AS last_ok FROM scan k WHERE k.domain_id = d.id AND k.status = 'klaar') ok ON true
       LEFT JOIN scan s ON s.domain_id = d.id AND s.status IN ('wachtrij', 'bezig')
      WHERE d.organization_id = $1 AND d.verified_at IS NOT NULL`,
    [organizationId],
  ))!;
  if (r.bezig) return { status: 'bezig', volgende: null };
  if (r.nooit || !r.oudste) return { status: 'eerste', volgende: null };
  return { status: 'gepland', volgende: new Date(r.oudste.getTime() + SCAN_INTERVAL_DAYS * DAY) };
}

// Detail per asset ------------------------------------------------------------------------

export interface AssetFindingDetail {
  id: string;
  title: string;
  detail: string;
  certainty: Certainty;
  level: Level;
  action: { key: string; title: string; why: string; forWho: ForWho } | null;
  vulns: { cveId: string; cvss: number | null; inKev: boolean; epss: number | null }[];
  sources: Source[];
  firstSeen: Date;
  lastSeen: Date;
  resolvedAt: Date | null;
  acceptedAt: Date | null;
}

export interface AssetDetail {
  asset: DashboardAsset & { source: string; managed: string; status: string };
  attributes: { key: string; value: unknown; certainty: Certainty; observedAt: Date }[];
  components: { kind: string; vendor: string | null; product: string; version: string | null; eolDate: Date | null }[];
  open: AssetFindingDetail[];
  closed: AssetFindingDetail[];
}

export async function getAssetDetail(p: Platform, userId: string, organizationId: string, assetId: string): Promise<AssetDetail> {
  await authorize(p.pool, userId, organizationId, 'bevindingen:lezen');
  if (!isUuid(assetId)) throw notFound('Dit asset');
  const a = await one<AssetRow & { source: string }>(
    p.pool,
    `SELECT id, type, value, visibility, exposure, managed, status, first_seen, last_seen, source
       FROM asset WHERE id = $1 AND organization_id = $2`,
    [assetId, organizationId],
  );
  if (!a) throw notFound('Dit asset');
  const findings = await many<FindingRow>(
    p.pool,
    `SELECT id, asset_id, check_key, finding_key, fingerprint, certainty, title, detail, sources,
            first_seen, last_seen, resolved_at, accepted_at
       FROM finding WHERE asset_id = $1 ORDER BY resolved_at DESC NULLS FIRST, first_seen DESC LIMIT 200`,
    [a.id],
  );
  const vulnRows = findings.length
    ? await many<VulnRow>(
        p.pool,
        `SELECT fv.finding_id, v.cve_id, v.euvd_id, v.cvss::text AS cvss, v.in_kev, v.epss::text AS epss
           FROM finding_vuln fv JOIN vuln v ON v.cve_id = fv.cve_id WHERE fv.finding_id = ANY($1::uuid[])
          ORDER BY v.in_kev DESC, v.cvss DESC NULLS LAST`,
        [findings.map((f) => f.id)],
      )
    : [];
  const vulns = new Map<string, VulnRow[]>();
  for (const v of vulnRows) vulns.set(v.finding_id, [...(vulns.get(v.finding_id) ?? []), v]);

  const openRows = findings.filter((f) => !f.resolved_at && !f.accepted_at);
  const scored = score({ findings: openRows.map((f) => toScoreFinding(f, a, vulns.get(f.id) ?? [])), outcomes: [] });
  const contribution = new Map(scored.contributions.map((c) => [c.fingerprint, c]));

  const detail = (f: FindingRow): AssetFindingDetail => {
    const vs = vulns.get(f.id) ?? [];
    const c = contribution.get(f.fingerprint);
    const kev = f.certainty === 'vastgesteld' && vs.some((v) => v.in_kev);
    const actionKey = c?.action;
    const def = actionKey ? ACTIONS[actionKey] : undefined;
    return {
      id: f.id,
      title: f.title,
      detail: f.detail,
      certainty: f.certainty,
      level: f.resolved_at || f.accepted_at ? 'ok' : levelFromWeight(c ? c.b * c.m * c.z * c.k : 0, kev),
      action: actionKey && def ? { key: actionKey, title: def.title, why: def.why, forWho: def.forWho } : null,
      vulns: vs.map((v) => ({ cveId: v.cve_id, cvss: v.cvss === null ? null : Number(v.cvss), inKev: v.in_kev, epss: v.epss === null ? null : Number(v.epss) })),
      sources: sourcesFor(Array.isArray(f.sources) ? f.sources : [], vs),
      firstSeen: f.first_seen,
      lastSeen: f.last_seen,
      resolvedAt: f.resolved_at,
      acceptedAt: f.accepted_at,
    };
  };
  const open = openRows.map(detail);
  const order: Record<Level, number> = { crit: 0, warn: 1, unk: 2, ok: 3 };
  open.sort((x, y) => order[x.level] - order[y.level]);

  const attributes = await many<{ key: string; value: unknown; certainty: Certainty; observed_at: Date }>(
    p.pool,
    'SELECT key, value, certainty, observed_at FROM asset_attribute WHERE asset_id = $1 ORDER BY key',
    [a.id],
  );
  const components = await many<{ kind: string; vendor: string | null; product: string; version: string | null; eol_date: Date | null }>(
    p.pool,
    'SELECT kind, vendor, product, version, eol_date FROM component WHERE asset_id = $1 ORDER BY kind, product',
    [a.id],
  );

  return {
    asset: {
      id: a.id,
      type: a.type,
      typeLabel: TYPE_LABELS[a.type] ?? a.type,
      group: GROUP_OF.get(a.type) ?? 'servers',
      label: assetLabel(a),
      level: worst(open.map((f) => f.level)),
      openFindings: open.length,
      exposure: a.exposure,
      lastSeen: a.last_seen,
      firstSeen: a.first_seen,
      source: a.source,
      managed: a.managed,
      status: a.status,
    },
    attributes: attributes.map((r) => ({ key: r.key, value: r.value, certainty: r.certainty, observedAt: r.observed_at })),
    components: components.map((c) => ({ kind: c.kind, vendor: c.vendor, product: c.product, version: c.version, eolDate: c.eol_date })),
    open,
    closed: findings.filter((f) => f.resolved_at || f.accepted_at).map(detail),
  };
}
