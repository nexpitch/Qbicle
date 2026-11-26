import type { InventoryAsset } from '@qbicle/inventory';
import type { Finding } from '@qbicle/score';
import { shortVendor } from './classify.ts';
import { CATEGORY_LABEL } from './findings.ts';
import type { LocalRunResult } from './lokaal.ts';

/**
 * Eenvoudig overzicht van de eerste netwerktest: één HTML-bestand zonder externe
 * bestanden, om in de browser te openen. Lijst met apparaten, type en risico.
 */
export type Risk = 'hoog' | 'midden' | 'laag' | 'onbekend' | 'geen';

const RISK_LABEL: Record<Risk, string> = {
  hoog: 'Hoog',
  midden: 'Midden',
  laag: 'Laag',
  onbekend: 'Onbekend apparaat',
  geen: 'Niets gevonden',
};
const RISK_ORDER: Risk[] = ['hoog', 'midden', 'laag', 'onbekend', 'geen'];

export function findingRisk(f: Finding): Exclude<Risk, 'onbekend' | 'geen'> {
  if (f.key.includes('beheerpoort') || f.vulns?.some((v) => v.inKev)) return 'hoog';
  if (/kwetsbaarheid|einde_ondersteuning|poort_open/.test(f.key)) return 'midden';
  return 'laag';
}

export interface DeviceRow {
  type: string;
  /** Afgeleid uit fabrikant, naam of diensten (dus niet zeker). */
  guessed: boolean;
  name: string;
  vendor: string;
  ip: string;
  risk: Risk;
  findings: string[];
}

export function deviceRows(assets: InventoryAsset[], findings: Finding[]): DeviceRow[] {
  const rows = assets
    .filter((a) => a.kind === 'apparaat' || a.kind === 'netwerkapparaat')
    .map((a): DeviceRow => {
      const own = findings.filter((f) => f.asset.value === a.key);
      const risks = own.map(findingRisk);
      const risk: Risk = RISK_ORDER.find((r) => (risks as Risk[]).includes(r)) ?? (a.category === 'onbekend' ? 'onbekend' : 'geen');
      const provider = a.attributes.provider?.value;
      const vendor = a.attributes.vendor?.value;
      return {
        type: provider ? `Modem van ${provider}` : capital(CATEGORY_LABEL[a.category] ?? (a.category === 'onbekend' ? 'Onbekend' : a.category)),
        guessed: a.kind === 'apparaat' && a.attributes.category?.certainty !== 'vastgesteld',
        name: a.attributes.name?.value ?? '',
        vendor: vendor ? shortVendor(vendor) : '',
        ip: a.identifiers.find((i) => i.type === 'ip')?.value ?? '',
        risk,
        findings: own.map((f) => f.title),
      };
    });
  const ipNum = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p || 0), 0);
  return rows.sort((x, y) => RISK_ORDER.indexOf(x.risk) - RISK_ORDER.indexOf(y.risk) || ipNum(x.ip) - ipNum(y.ip));
}

export function renderReport(r: LocalRunResult, meta: { generatedAt: Date; pingSweep: boolean }): string {
  const rows = deviceRows(r.assets, r.findings);
  const wan = r.assets.filter((a) => a.kind === 'ip-adres').map((a) => a.identifiers.find((i) => i.type === 'ip')?.value).filter(Boolean);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const when = meta.generatedAt.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
  const warnings = [...r.notes, ...r.readouts.flatMap((x) => x.warnings), ...r.sources.filter((s) => s.error).map((s) => `${s.sourceId}: ${s.error}`)];

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qbicle netwerktest</title>
<style>
:root { --petrol:#034D6C; --aqua:#48BFB8; --bg:#f6f8f9; --card:#fff; --text:#13232c; --muted:#5b6b73; --line:#e1e7ea;
  --hoog:#b42318; --midden:#b54708; --laag:#2e6f8e; --onbekend:#6b7280; --geen:#1f7a4d; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d171c; --card:#15232a; --text:#e6eef1; --muted:#9db0b8; --line:#26363e; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, "Segoe UI", Inter, sans-serif; }
header { background:var(--petrol); color:#fff; padding:24px 16px; }
header h1 { margin:0 0 4px; font-size:22px; }
header p { margin:0; opacity:.85; }
main { max-width:1000px; margin:0 auto; padding:16px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:8px 0 20px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size:24px; }
.tile span { color:var(--muted); font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:4px 0; margin-bottom:20px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tr:last-child td { border-bottom:0; }
.risk { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; color:#fff; white-space:nowrap; }
.hoog{background:var(--hoog)} .midden{background:var(--midden)} .laag{background:var(--laag)} .onbekend{background:var(--onbekend)} .geen{background:var(--geen)}
.muted { color:var(--muted); font-size:13px; }
ul { margin:4px 0 0; padding-left:18px; }
h2 { font-size:17px; margin:24px 0 8px; color:var(--petrol); }
@media (prefers-color-scheme: dark) { h2 { color:var(--aqua); } }
</style>
</head>
<body>
<header>
  <h1>Je netwerk in kaart</h1>
  <p>Qbicle netwerktest · ${esc(when)} · gateway ${esc(r.gateway)}</p>
</header>
<main>
  <div class="tiles">
    <div class="tile"><b>${rows.length}</b><span>apparaten gezien</span></div>
    <div class="tile"><b>${r.findings.length}</b><span>bevindingen</span></div>
    <div class="tile"><b>${r.score.urgency}/100</b><span>urgentie: ${esc(r.score.band.label)}</span></div>
    <div class="tile"><b>${wan.length ? esc(wan.join(', ')) : 'onbekend'}</b><span>internetadres</span></div>
  </div>

  <h2>Apparaten</h2>
  <div class="card"><table>
    <thead><tr><th>Type</th><th>Naam</th><th>Fabrikant</th><th>IP-adres</th><th>Risico</th></tr></thead>
    <tbody>
${rows
  .map(
    (row) => `      <tr><td>${esc(row.type)}${row.guessed && row.type !== 'Onbekend' ? ' <span class="muted">(vermoedelijk)</span>' : ''}</td><td>${esc(row.name)}</td><td>${esc(row.vendor)}</td><td>${esc(row.ip)}</td><td><span class="risk ${row.risk}">${RISK_LABEL[row.risk]}</span>${
      row.findings.length ? `<ul>${row.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''
    }</td></tr>`,
  )
  .join('\n')}
    </tbody>
  </table></div>
  <p class="muted">Per type: ${[...counts].map(([t, n]) => `${esc(t)} ${n}`).join(' · ')}</p>

  <h2>Wat te doen</h2>
  <div class="card" style="padding:8px 14px">
    ${
      r.findings.length
        ? `<ul>${r.findings.map((f) => `<li><b>${esc(f.title)}</b><br><span class="muted">${esc(f.detail)}</span></li>`).join('')}</ul>`
        : '<p>We zagen in deze test geen bevindingen. Dat betekent niet dat alles veilig is: van de meeste apparaten kennen we de softwareversie nog niet.</p>'
    }
  </div>

  <h2>Wat deze test wel en niet deed</h2>
  <div class="card" style="padding:8px 14px">
    <ul>
      <li>Het modem is uitgelezen via UPnP, zonder wachtwoord en zonder iets te veranderen${r.upnpLocation ? '' : ' (geen antwoord, zie hieronder)'}.</li>
      <li>De apparaten komen uit de lijst die je Mac al van het netwerk kent (ARP-tabel)${meta.pingSweep ? ', na één keer groeten (ping) van de adressen in je eigen netwerk, met jouw scanopdracht' : ''}.</li>
      <li>Je Mac zelf staat niet in de lijst. Apparaten die uit staan of op het gastnetwerk zitten, zie je ook niet.</li>
      <li>Er is niet op poorten gescand en er zijn geen kwetsbaarheden uitgeprobeerd.</li>
      <li>Namen die op een persoon lijken, korten we in (AVG). Alles blijft op je eigen computer.</li>
    </ul>
    ${warnings.length ? `<p class="muted">Meldingen:</p><ul class="muted">${[...new Set(warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>
</main>
</body>
</html>
`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
