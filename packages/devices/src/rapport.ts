import { isRandomizedMac, type InventoryAsset } from '@qbicle/inventory';
import type { Finding } from '@qbicle/score';
import { shortVendor } from './classify.ts';
import { CATEGORY_LABEL } from './findings.ts';
import type { LocalRunResult } from './lokaal.ts';
import type { ClassifiedClient } from './observations.ts';
import { PROVIDER_MODEM_VENDORS } from './providers.ts';

/**
 * Overzicht van de netwerktest: één HTML-bestand zonder externe bestanden, om in de
 * browser te openen. Per apparaat type, fabrikant, model, risico en waar dat vandaan komt.
 * Onbekende apparaten kun je zelf benoemen; die namen gaan via netwerk/namen.csv mee in
 * de volgende run.
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

/** Typen waaruit je kiest als je een apparaat zelf benoemt (zelfde als de categorieën). */
export const NAME_TYPES = ['Laptop', 'Computer', 'Telefoon', 'Tablet', 'Tv of mediaspeler', 'Slimme speaker', 'Printer', 'Camera', 'Slim apparaat', 'Huishoudapparaat', 'Wifi-accesspoint', 'Router', 'NAS', 'Server', 'Alarmsysteem', 'Zonnepanelen', 'Laadpaal', 'Anders'];

export function findingRisk(f: Finding): Exclude<Risk, 'onbekend' | 'geen'> {
  if (f.key.includes('beheerpoort') || f.vulns?.some((v) => v.inKev)) return 'hoog';
  if (/kwetsbaarheid|einde_ondersteuning|poort_open/.test(f.key)) return 'midden';
  return 'laag';
}

/** Een naam die je zelf gaf (netwerk/namen.csv). */
export interface ManualName {
  name: string;
  type?: string;
}

/** "aa:bb:cc:dd:ee:ff,Vaatwasser,Huishoudapparaat" per regel; # = opmerking. Ook ; als scheidingsteken. */
export function parseNames(csv: string): Map<string, ManualName> {
  const out = new Map<string, ManualName>();
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [mac, name, type] = line.split(/[;,]/).map((v) => v.replace(/^"|"$/g, '').trim());
    if (!mac || !name || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) continue;
    out.set(mac.toLowerCase(), { name: name.slice(0, 60), type: type?.slice(0, 40) || undefined });
  }
  return out;
}

export interface DeviceRow {
  type: string;
  certainty: 'Vastgesteld' | 'Vermoedelijk' | 'Onbekend' | 'Door jou opgegeven';
  name: string;
  vendor: string;
  model: string;
  os: string;
  ip: string;
  mac: string;
  lastSeen: string;
  sources: string[];
  reasons: string[];
  /** Alleen bij onbekend: waarom, en wat helpt. */
  whyUnknown?: string;
  risk: Risk;
  findings: string[];
}

/** Gok van het besturingssysteem, alleen uit wat we al weten (geen vingerafdruk-scan). */
export function osGuess(input: { category: string; vendor?: string; model?: string; name?: string; services?: string[] }): string {
  const v = (input.vendor ?? '').toLowerCase();
  const m = `${input.model ?? ''} ${input.name ?? ''}`.toLowerCase();
  if (/iphone/.test(m) || (v.includes('apple') && input.category === 'telefoon')) return 'iOS';
  if (/ipad/.test(m)) return 'iPadOS';
  if (/macbook|imac|mac-?mini|^mac\b|macpro/.test(m) || (v.includes('apple') && input.category === 'laptop')) return 'macOS';
  if (/appletv|apple-?tv|audioaccessory|homepod/.test(m)) return 'tvOS / HomePod';
  if (/galaxy|android|pixel|^sm-/.test(m) || /samsung|xiaomi|oneplus|oppo/.test(v) && input.category === 'telefoon') return 'Android';
  if (/webos|lgwebostv/.test(m)) return 'webOS (LG)';
  if (/tizen/.test(m)) return 'Tizen (Samsung)';
  if (/chromecast|googlecast|google-?tv/.test(m) || input.services?.includes('_googlecast._tcp')) return 'Google Cast';
  if (/desktop-|laptop-|windows/.test(m)) return 'Windows';
  if (v.includes('sonos')) return 'Sonos-software';
  if (/espressif|tuya|smart innovation/.test(v) || /^lwip|^wlan0|^esp/.test(m)) return 'Ingebouwde firmware (ESP/Tuya)';
  if (/tp-link|tp link/.test(v) && input.category === 'accesspoint') return 'TP-Link-firmware (Deco)';
  if (input.category === 'printer') return 'Printerfirmware';
  if (input.category === 'router') return 'Firmware van de provider of fabrikant';
  return '';
}

function whyUnknown(a: InventoryAsset, mac: string, vendor: string, sources: string[]): string {
  if (mac && isRandomizedMac(mac)) {
    return 'Dit apparaat gebruikt een privacy-MAC-adres (telefoons, tablets en laptops doen dat per wifi-netwerk), dus de fabrikant is verborgen. Bonjour of een naam in het netwerk ontbreekt ook.';
  }
  if (vendor) {
    return `De fabrikant is ${vendor}, maar die maakt veel soorten apparaten en het apparaat geeft geen naam of dienst door.`;
  }
  if (!sources.includes('MAC-fabrikant')) return 'De fabrikant staat niet in het register van MAC-adressen en het apparaat geeft geen naam of dienst door.';
  return 'Te weinig aanwijzingen om het type te bepalen.';
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function deviceRows(r: Pick<LocalRunResult, 'assets' | 'findings' | 'clients'> & Partial<Pick<LocalRunResult, 'evidence' | 'macs'>>, names = new Map<string, ManualName>()): DeviceRow[] {
  const byIp = new Map<string, ClassifiedClient>();
  for (const c of r.clients) {
    const ip = c.identifiers.find((i) => i.type === 'ip')?.value;
    if (ip) byIp.set(ip, c);
  }
  const rows = r.assets
    .filter((a) => a.kind === 'apparaat' || a.kind === 'netwerkapparaat')
    .map((a): DeviceRow => {
      const ip = a.identifiers.find((i) => i.type === 'ip')?.value ?? '';
      const mac = (r.macs?.[ip] ?? a.identifiers.find((i) => i.type === 'mac')?.value ?? '').toLowerCase();
      const own = r.findings.filter((f) => f.asset.value === a.key);
      const risks = own.map(findingRisk);
      const provider = a.attributes.provider?.value;
      const rawVendor = a.attributes.vendor?.value;
      const vendor = rawVendor && rawVendor !== 'onbekend' ? shortVendor(rawVendor) : '';
      const sources: string[] = [...(r.evidence?.[ip] ?? [])];
      const client = byIp.get(ip);
      const manual = mac ? names.get(mac) : undefined;
      const services = a.attributes.services?.value as string[] | undefined;
      const isModem = a.kind === 'netwerkapparaat' && a.category === 'router' && rawVendor && PROVIDER_MODEM_VENDORS.test(rawVendor);
      let type = provider ? `Modem van ${provider}` : isModem ? 'Modem (van je provider)' : capital(CATEGORY_LABEL[a.category] ?? (a.category === 'onbekend' ? 'Onbekend' : a.category));
      let certainty: DeviceRow['certainty'] =
        a.kind === 'netwerkapparaat' ? 'Vastgesteld' : a.category === 'onbekend' ? 'Onbekend' : a.attributes.category?.certainty === 'vastgesteld' ? 'Vastgesteld' : 'Vermoedelijk';
      let name = a.attributes.name?.value ?? '';
      if (manual) {
        name = manual.name;
        if (manual.type) type = manual.type;
        certainty = 'Door jou opgegeven';
        sources.push('zelf benoemd');
      }
      const unknown = certainty === 'Onbekend';
      const risk: Risk = RISK_ORDER.find((x) => (risks as Risk[]).includes(x)) ?? (unknown ? 'onbekend' : 'geen');
      const model = a.attributes.model?.value ?? '';
      return {
        type,
        certainty,
        name,
        vendor,
        model,
        os: osGuess({ category: a.category, vendor: rawVendor, model, name: a.attributes.name?.value, services }),
        ip,
        mac,
        lastSeen: a.lastSeen,
        sources,
        reasons: client?.classification.reasons ?? [],
        whyUnknown: unknown ? whyUnknown(a, mac, vendor, sources) : undefined,
        risk,
        findings: own.map((f) => f.title),
      };
    });
  const ipNum = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p || 0), 0);
  return rows.sort((x, y) => RISK_ORDER.indexOf(x.risk) - RISK_ORDER.indexOf(y.risk) || ipNum(x.ip) - ipNum(y.ip));
}

export function renderReport(r: LocalRunResult, meta: { generatedAt: Date; pingSweep: boolean; names?: Map<string, ManualName>; bonjour?: boolean }): string {
  const rows = deviceRows(r, meta.names);
  const wan = r.assets.filter((a) => a.kind === 'ip-adres').map((a) => a.identifiers.find((i) => i.type === 'ip')?.value).filter(Boolean);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const known = rows.filter((x) => x.certainty !== 'Onbekend').length;
  const tz = { timeZone: 'Europe/Amsterdam' } as const;
  const when = meta.generatedAt.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', ...tz });
  const time = (iso: string) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short', ...tz }) : '');
  const warnings = [...r.notes, ...r.readouts.flatMap((x) => x.warnings), ...r.sources.filter((s) => s.error).map((s) => `${s.sourceId}: ${s.error}`)];
  const names = Object.fromEntries([...(meta.names ?? new Map())].map(([mac, n]) => [mac, n]));

  const row = (d: DeviceRow) => `      <tr class="${d.certainty === 'Onbekend' ? 'unknown' : ''}">
        <td><b>${esc(d.type)}</b><br><span class="muted">${esc(d.certainty)}</span></td>
        <td>${esc(d.name) || '<span class="muted">geen naam</span>'}${d.os ? `<br><span class="muted">${esc(d.os)}</span>` : ''}</td>
        <td>${esc(d.vendor) || '<span class="muted">onbekend</span>'}${d.model ? `<br><span class="muted">${esc(d.model)}</span>` : ''}</td>
        <td>${esc(d.ip)}</td>
        <td><span class="risk ${d.risk}">${RISK_LABEL[d.risk]}</span>${d.findings.length ? `<ul>${d.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          <details${d.certainty === 'Onbekend' ? ' open' : ''}><summary>Meer</summary>
            <dl>
              <dt>MAC-adres</dt><dd>${esc(d.mac) || 'onbekend'}${d.mac && isRandomizedMac(d.mac) ? ' (privacy-adres)' : ''}</dd>
              <dt>Laatst gezien</dt><dd>${esc(time(d.lastSeen))}</dd>
              <dt>Bron</dt><dd>${esc(d.sources.join(', ') || 'onbekend')}</dd>
              ${d.reasons.length ? `<dt>Waarom dit type</dt><dd>${esc(d.reasons.join('; '))}</dd>` : ''}
              ${d.whyUnknown ? `<dt>Waarom onbekend</dt><dd>${esc(d.whyUnknown)}</dd>` : ''}
            </dl>
            ${d.mac ? `<div class="name" data-mac="${esc(d.mac)}"><input placeholder="Wat is dit? Bijv. Vaatwasser" value="${esc(names[d.mac]?.name ?? '')}" aria-label="Naam"><select aria-label="Type"><option value="">Type…</option>${NAME_TYPES.map((t) => `<option${names[d.mac]?.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
          </details>
        </td>
      </tr>`;

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qbicle netwerktest</title>
<style>
:root { --petrol:#034D6C; --aqua:#48BFB8; --bg:#f6f8f9; --card:#fff; --text:#13232c; --muted:#5b6b73; --line:#e1e7ea; --unknown:#fbfaf3;
  --hoog:#b42318; --midden:#b54708; --laag:#2e6f8e; --onbekend:#6b7280; --geen:#1f7a4d; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d171c; --card:#15232a; --text:#e6eef1; --muted:#9db0b8; --line:#26363e; --unknown:#1b2a22; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, "Segoe UI", Inter, sans-serif; }
header { background:var(--petrol); color:#fff; padding:24px 16px; }
header h1 { margin:0 0 4px; font-size:22px; }
header p { margin:0; opacity:.85; }
main { max-width:1100px; margin:0 auto; padding:16px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:8px 0 20px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size:24px; }
.tile span { color:var(--muted); font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:4px 0; margin-bottom:20px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tr.unknown { background:var(--unknown); }
tr:last-child td { border-bottom:0; }
.risk { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; color:#fff; white-space:nowrap; }
.hoog{background:var(--hoog)} .midden{background:var(--midden)} .laag{background:var(--laag)} .onbekend{background:var(--onbekend)} .geen{background:var(--geen)}
.muted { color:var(--muted); font-size:13px; }
ul { margin:4px 0 0; padding-left:18px; }
details { margin-top:6px; font-size:13px; }
summary { cursor:pointer; color:var(--petrol); }
dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 10px; margin:6px 0; }
dt { color:var(--muted); } dd { margin:0; }
.name { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.name input, .name select { font:inherit; padding:4px 6px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--text); }
.name input { min-width:180px; }
button { font:inherit; background:var(--petrol); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; }
h2 { font-size:17px; margin:24px 0 8px; color:var(--petrol); }
@media (prefers-color-scheme: dark) { h2, summary { color:var(--aqua); } }
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
    <div class="tile"><b>${known} van ${rows.length}</b><span>herkend</span></div>
    <div class="tile"><b>${r.findings.length}</b><span>bevindingen</span></div>
    <div class="tile"><b>${r.score.urgency}/100</b><span>urgentie: ${esc(r.score.band.label)}</span></div>
    <div class="tile"><b>${wan.length ? esc(wan.join(', ')) : 'onbekend'}</b><span>internetadres</span></div>
  </div>

  <h2>Apparaten</h2>
  <div class="card"><table>
    <thead><tr><th>Type</th><th>Naam</th><th>Fabrikant en model</th><th>IP-adres</th><th>Risico en details</th></tr></thead>
    <tbody>
${rows.map(row).join('\n')}
    </tbody>
  </table></div>
  <p class="muted">Per type: ${[...counts].map(([t, n]) => `${esc(t)} ${n}`).join(' · ')}</p>

  <h2>Zelf benoemen</h2>
  <div class="card" style="padding:8px 14px">
    <p>Weet je wat een apparaat is? Vul bij "Meer" een naam en type in en klik daarna op de knop. Je browser bewaart een bestand <b>qbicle-namen.csv</b> in Downloads. Bij de volgende run neemt Qbicle die namen vanzelf over.</p>
    <p><button id="save">Download mijn namen</button> <span id="saved" class="muted"></span></p>
  </div>

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
      <li>De fabrikant komt uit het openbare register van MAC-adressen (IEEE), offline opgezocht.</li>
      ${meta.bonjour ? '<li>Namen, diensten en modellen komen ook uit Bonjour: wat apparaten zelf in je netwerk aankondigen.</li>' : ''}
      ${meta.pingSweep ? '<li>Met je scanopdracht is elk apparaat één keer gevraagd om zijn UPnP-beschrijving (fabrikant en model).</li>' : ''}
      <li>Apparaten die uit staan of op het gastnetwerk zitten, zie je niet.</li>
      <li>Er is niet op poorten gescand en er zijn geen kwetsbaarheden uitgeprobeerd.</li>
      <li>Namen die op een persoon lijken, korten we in (AVG). Alles blijft op je eigen computer.</li>
    </ul>
    ${warnings.length ? `<p class="muted">Meldingen:</p><ul class="muted">${[...new Set(warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>
</main>
<script>
(function () {
  var known = ${JSON.stringify(names).replace(/</g, '\\u003c')};
  var key = 'qbicle-namen';
  try { var saved = JSON.parse(localStorage.getItem(key) || '{}'); for (var m in saved) known[m] = saved[m]; } catch (e) {}
  document.querySelectorAll('.name').forEach(function (el) {
    var mac = el.getAttribute('data-mac'), input = el.querySelector('input'), select = el.querySelector('select');
    if (known[mac]) { input.value = known[mac].name || ''; select.value = known[mac].type || ''; }
    function store() {
      if (input.value.trim()) known[mac] = { name: input.value.trim(), type: select.value }; else delete known[mac];
      try { localStorage.setItem(key, JSON.stringify(known)); } catch (e) {}
    }
    input.addEventListener('change', store); select.addEventListener('change', store);
  });
  document.getElementById('save').addEventListener('click', function () {
    var lines = ['# mac,naam,type (Qbicle netwerktest)'];
    for (var m in known) lines.push([m, known[m].name, known[m].type || ''].map(function (v) { return String(v).replace(/[,;\\n"]/g, ' '); }).join(','));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\\n') + '\\n'], { type: 'text/csv' }));
    a.download = 'qbicle-namen.csv';
    document.body.appendChild(a); a.click(); a.remove();
    document.getElementById('saved').textContent = (lines.length - 1) + ' namen bewaard. Start de test opnieuw om ze te zien.';
  });
})();
</script>
</body>
</html>
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
