// Qbicle web-app: kleine hulp voor formulieren. De pagina's werken als gewone
// HTML; dit script stuurt formulieren als JSON naar de API (/api/v1), toont
// foutmeldingen in gewone taal en gaat daarna naar de volgende pagina.
(function () {
  'use strict';

  function store(op, key, value) {
    try {
      if (op === 'set') sessionStorage.setItem('qbicle_' + key, value);
      else if (op === 'remove') sessionStorage.removeItem('qbicle_' + key);
      else return sessionStorage.getItem('qbicle_' + key);
    } catch (e) { return null; }
    return null;
  }

  function pick(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  function nextUrl(template, json) {
    // {veld} wordt vervangen door een waarde uit het antwoord. Een veld dat zelf een
    // volledige URL is (de betaalpagina) gebruik je met data-next-veld.
    return template.replace(/\{([\w.]+)\}/g, function (_, k) { return encodeURIComponent(pick(json, k) ?? ''); });
  }

  function formToJson(form, submitter) {
    var data = {};
    // Groepen vinkjes (data-meerdere) worden een lijst, ook als er niets is aangevinkt.
    form.querySelectorAll('[data-meerdere]').forEach(function (el) { data[el.name] = []; });
    new FormData(form).forEach(function (value, key) {
      var el = form.querySelector('[name="' + key + '"]');
      if (el && el.hasAttribute('data-meerdere')) {
        data[key].push(value);
      } else if (el && el.hasAttribute('data-lijst')) {
        data[key] = String(value).split(/[\s,;]+/).filter(Boolean);
      } else {
        data[key] = value;
      }
    });
    if (submitter && submitter.name) data[submitter.name] = submitter.value;
    return data;
  }

  async function send(url, method, body) {
    var res = await fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var json = {};
    if (res.status !== 204) {
      try { json = await res.json(); } catch (e) { json = {}; }
    }
    return { ok: res.ok, status: res.status, json: json };
  }

  function showError(form, text) {
    var box = form.querySelector('.form-fout');
    if (!box) { box = document.createElement('p'); box.className = 'form-fout'; box.setAttribute('role', 'alert'); form.prepend(box); }
    box.textContent = text;
    box.hidden = false;
  }

  document.addEventListener('submit', async function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.api) return;
    e.preventDefault();
    if (form.dataset.bevestig && !window.confirm(form.dataset.bevestig)) return;
    var buttons = form.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; });
    var err = form.querySelector('.form-fout');
    if (err) err.hidden = true;
    try {
      var r = await send(form.dataset.api, form.dataset.method || 'POST', formToJson(form, e.submitter));
      if (!r.ok) {
        if (r.status === 401) { location.href = '/inloggen'; return; }
        showError(form, r.json.bericht || 'Er ging iets mis. Probeer het opnieuw.');
        return;
      }
      if (form.dataset.toonVeld) {
        // Toon een waarde uit het antwoord (bijv. een deellink) in plaats van te herladen.
        var out = document.getElementById(form.dataset.toonIn || '');
        if (out) { out.value = String(pick(r.json, form.dataset.toonVeld) ?? ''); out.hidden = false; out.focus(); out.select(); }
        return;
      }
      if (form.dataset.nextVeld) {
        var dest = pick(r.json, form.dataset.nextVeld);
        if (dest) { location.href = dest; return; }
      }
      if (form.dataset.next) { location.href = nextUrl(form.dataset.next, r.json); return; }
      location.reload();
    } catch (x) {
      showError(form, 'Geen verbinding met Qbicle. Controleer je internet en probeer het opnieuw.');
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  });

  // Pakketkeuze: bij wisselen van product het eerste pakket van dat product kiezen.
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLInputElement) || t.name !== 'product') return;
    var panel = document.querySelector('.product-panel.' + t.value);
    var first = panel && panel.querySelector('input[name="pakket"]');
    if (first && !(panel.querySelector('input[name="pakket"]:checked'))) first.checked = true;
    var url = new URL(location.href);
    url.searchParams.set('product', t.value);
    history.replaceState(null, '', url);
  });

  // Kopieerknoppen: waarde op het klembord, korte melding "Gekopieerd".
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.className = 'copy-hidden';
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(t);
      ok ? resolve() : reject(new Error('kopiëren lukt niet'));
    });
  }
  var live = document.createElement('p');
  live.className = 'copy-hidden'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  document.addEventListener('click', function (e) {
    var btn = e.target instanceof Element ? e.target.closest('[data-kopieer]') : null;
    if (!btn) return;
    copyText(btn.getAttribute('data-kopieer')).then(function () {
      btn.classList.add('gekopieerd');
      live.textContent = 'Gekopieerd';
      setTimeout(function () { btn.classList.remove('gekopieerd'); live.textContent = ''; }, 1600);
    }, function () {
      live.textContent = 'Kopiëren lukte niet. Selecteer de tekst en kopieer hem zelf.';
    });
  });

  // Links uit e-mails: het token staat achter # en gaat met een POST naar de API.
  var tokenBox = document.querySelector('[data-token-post]');
  if (tokenBox) {
    var token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    var status = tokenBox.querySelector('[data-status]');
    if (!token) {
      status.textContent = 'Deze link is niet compleet. Kopieer de hele link uit de e-mail, of vraag een nieuwe aan.';
    } else {
      send(tokenBox.dataset.tokenPost, 'POST', { token: token }).then(function (r) {
        // Uitnodiging openen zonder in te loggen: token even bewaren, inloggen, daarna verder.
        if (r.status === 401 && tokenBox.dataset.bewaarToken) {
          store('set', tokenBox.dataset.bewaarToken, token);
          location.href = '/inloggen';
          return;
        }
        if (!r.ok) { status.textContent = r.json.bericht || 'Deze link werkt niet meer. Vraag een nieuwe aan.'; return; }
        var reg = r.json.registratie;
        var pending = store('get', 'uitnodiging');
        if (pending && !tokenBox.dataset.bewaarToken) {
          store('remove', 'uitnodiging');
          location.href = '/uitnodiging#token=' + encodeURIComponent(pending);
        } else if (reg && reg.organizationId) {
          location.href = '/o/' + reg.organizationId + (reg.product === 'audit' ? '/audit/bestellen' : '/welkom');
        } else if (r.json.organizationId) {
          location.href = '/o/' + r.json.organizationId + '/overzicht';
        } else {
          location.href = tokenBox.dataset.next || '/overzicht';
        }
      }, function () {
        status.textContent = 'Geen verbinding met Qbicle. Probeer het opnieuw.';
      });
    }
  }
  // Live voortgang van een scan: elke 2 seconden de stand ophalen. De controles die
  // de scanner afrondde, tonen we één voor één (met hun echte uitslag), zodat je ziet
  // wat er gecontroleerd wordt. Alleen de weergave wacht: we verzinnen niets en de
  // uitslag is al bekend. Daarna een samenvatting en door naar het overzicht.
  var scanBox = document.querySelector('[data-scan]');
  if (scanBox && /^(wachtrij|bezig)$/.test(scanBox.dataset.scanStatus || '')) {
    var LABEL = { wachten: ['Wacht', 'unk'], bezig: ['Bezig', 'warn'], klaar: ['Klaar', 'ok'] };
    var BADGE = { wachtrij: ['In de wachtrij', 'unk'], bezig: ['Bezig', 'warn'], klaar: ['Klaar', 'ok'], mislukt: ['Niet gelukt', 'crit'] };
    var REVEAL_MS = 1100; // per controle
    var MIN_MS = 15000; // de voortgang staat minstens zo lang in beeld
    var REDIRECT_MS = 7000;
    var badge = function (el, pair) {
      if (!el) return;
      el.innerHTML = '';
      var span = document.createElement('span');
      span.className = 'status st-' + pair[1];
      var dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      span.appendChild(dot);
      span.appendChild(document.createTextNode(pair[0]));
      el.appendChild(span);
    };
    var uitslag = function (c) {
      if (c.uitkomst === 'ok') return ['In orde', 'ok'];
      if (c.uitkomst === 'finding') return [c.bevindingen === 1 ? '1 bevinding' : c.bevindingen + ' bevindingen', 'warn'];
      if (c.uitkomst === 'not_applicable') return ['Niet van toepassing', 'unk'];
      return ['Niet te controleren', 'unk'];
    };
    var samenvatting = function (cs) {
      var u = 0, b = 0, n = 0;
      cs.forEach(function (c) {
        if (c.uitkomst === 'ok' || c.uitkomst === 'finding') u++;
        if (c.uitkomst === 'finding') b += c.bevindingen;
        if (c.uitkomst === 'unknown' || c.uitkomst === 'error') n++;
      });
      return 'Dit hebben we gecontroleerd: ' + (u === 1 ? '1 controle' : u + ' controles') + ', ' +
        (b === 0 ? 'geen bevindingen' : b === 1 ? '1 bevinding' : b + ' bevindingen') +
        (n ? '. ' + (n === 1 ? '1 controle kon' : n + ' controles konden') + ' we deze keer niet uitvoeren' : '') + '.';
    };
    var q = function (sel) { return scanBox.querySelector(sel); };
    var lijst = q('[data-scan-controles]');
    var nu = q('[data-scan-nu]');
    var begin = Date.now();
    var shown = lijst ? lijst.children.length : 0; // al op de pagina gezet door de server
    var laatste = null; // laatste antwoord van de server
    var revealing = false;
    var klaarGetoond = false;
    var stapTekst = function (groep) {
      var li = scanBox.querySelector('[data-stap="' + groep + '"]');
      return (li && li.dataset.stapBezig) || 'We controleren';
    };
    var setStap = function (li, status) {
      if (!li || li.dataset.stapStatus === status) return;
      li.dataset.stapStatus = status;
      badge(li.querySelector('[data-stap-badge]'), LABEL[status]);
    };
    // Stappen en balk volgen wat al in beeld is, niet wat de server al weet.
    var render = function () {
      var s = laatste;
      if (!s) return;
      var cs = s.controles || [];
      var zichtbaar = cs.filter(function (c) { return gezien[sleutel(c)]; });
      (s.steps || []).forEach(function (st) {
        var li = scanBox.querySelector('[data-stap="' + st.key + '"]');
        var inGroep = cs.filter(function (c) { return c.groep === st.key; }).length;
        var getoond = zichtbaar.filter(function (c) { return c.groep === st.key; }).length;
        var status = 'wachten';
        if (st.status === 'klaar' && getoond >= inGroep) status = 'klaar';
        else if (getoond > 0 || (st.status !== 'wachten' && cs.length === 0)) status = 'bezig';
        setStap(li, status);
      });
      var balk = q('[data-scan-balk]');
      var pct = s.status === 'klaar' || s.status === 'bezig'
        ? (cs.length ? Math.round(5 + 90 * shown / cs.length) : s.pct)
        : s.pct;
      if (s.status === 'bezig') pct = Math.min(pct, s.pct);
      if (s.status === 'klaar' && shown >= cs.length && Date.now() - begin >= MIN_MS) pct = 100;
      if (balk) { balk.value = pct; balk.parentNode.setAttribute('aria-valuenow', String(pct)); }
    };
    var toon = function (c, direct) {
      if (!lijst) return;
      q('[data-scan-controles-blok]').hidden = false;
      var li = document.createElement('li');
      li.setAttribute('data-controle', sleutel(c));
      var t = document.createElement('span');
      t.className = 'stap-tekst';
      var st = document.createElement('strong');
      st.textContent = c.titel;
      var a = document.createElement('span');
      a.className = 'stap-uitleg';
      a.textContent = c.asset;
      t.appendChild(st);
      t.appendChild(a);
      var b = document.createElement('span');
      li.appendChild(t);
      li.appendChild(b);
      lijst.appendChild(li);
      if (direct) { badge(b, uitslag(c)); return; }
      li.dataset.bezig = '';
      badge(b, ['Bezig', 'warn']);
      if (nu) { nu.hidden = false; nu.textContent = stapTekst(c.groep) + '…'; }
      setTimeout(function () { delete li.dataset.bezig; badge(b, uitslag(c)); }, Math.round(REVEAL_MS * 0.6));
    };
    // In de volgorde van de stappen tonen (DNS, e-mail, certificaat, website), ook als de
    // scanner ze door elkaar afrondde. Bijhouden welke al in beeld zijn via sleutel + asset.
    var gezien = {};
    var STAP_VOLGORDE = Array.prototype.map.call(scanBox.querySelectorAll('[data-stap]'), function (li) { return li.dataset.stap; });
    var sleutel = function (c) { return c.key + '|' + c.asset; };
    if (lijst) Array.prototype.forEach.call(lijst.children, function (li) { gezien[li.getAttribute('data-controle')] = true; });
    var volgendeControle = function (cs) {
      var best = null;
      cs.forEach(function (c, i) {
        if (gezien[sleutel(c)]) return;
        var r = STAP_VOLGORDE.indexOf(c.groep) * 1000 + i;
        if (!best || r < best.r) best = { c: c, r: r };
      });
      return best && best.c;
    };
    var volgende = function () {
      var s = laatste;
      var cs = (s && s.controles) || [];
      var c = volgendeControle(cs);
      if (c) {
        revealing = true;
        gezien[sleutel(c)] = true;
        toon(c, false);
        shown++;
        render();
        setTimeout(volgende, REVEAL_MS);
        return;
      }
      revealing = false;
      if (s && s.status === 'klaar') afronden();
    };
    var afronden = function () {
      var s = laatste;
      if (klaarGetoond) return;
      var wacht = MIN_MS - (Date.now() - begin);
      if (wacht > 0) {
        if (nu) { nu.hidden = false; nu.textContent = 'We zetten de uitkomsten op een rij…'; }
        setTimeout(afronden, Math.min(wacht, 1500));
        return;
      }
      klaarGetoond = true;
      render();
      if (nu) nu.hidden = true;
      var titel = document.querySelector('[data-scan-titel]');
      if (titel) titel.textContent = 'Scan van ' + s.domain + ' is klaar';
      badge(q('[data-scan-badge]'), BADGE.klaar);
      q('[data-scan-tekst]').textContent = 'Klaar. Je resultaten staan in het overzicht.';
      var sv = q('[data-scan-samenvatting]');
      if (sv && s.controles && s.controles.length) { sv.textContent = samenvatting(s.controles); sv.hidden = false; }
      var res = q('[data-scan-resultaat]');
      if (res && s.result) {
        res.textContent = 'Urgentie ' + s.result.urgency + ', ' + (s.result.openFindings === 1 ? 'één punt' : s.result.openFindings + ' punten') +
          ' om naar te kijken. We sturen je zo door naar het overzicht.';
        res.hidden = false;
      }
      scanBox.querySelectorAll('[hidden]').forEach(function (el) { if (el.matches('a')) el.hidden = false; });
      setTimeout(function () { location.href = scanBox.dataset.scanKlaar; }, REDIRECT_MS);
    };
    var fouten = 0;
    var tick = async function () {
      var r;
      try { r = await send(scanBox.dataset.scan, 'GET'); } catch (e) { r = null; }
      if (!r || !r.ok) {
        if (r && r.status === 401) { location.href = '/inloggen'; return; }
        if (++fouten > 5) { q('[data-scan-tekst]').textContent = 'We kunnen de voortgang nu niet ophalen. Ververs de pagina over een minuut.'; return; }
        setTimeout(tick, 4000);
        return;
      }
      fouten = 0;
      var s = r.json;
      laatste = s;
      if (s.status !== 'klaar') badge(q('[data-scan-badge]'), BADGE[s.status] || BADGE.wachtrij);
      var tekst = q('[data-scan-tekst]');
      var titel = document.querySelector('[data-scan-titel]');
      var vast = q('[data-scan-vast]');
      var isVast = s.status === 'wachtrij' && s.wacht && s.wacht.vast;
      if (vast) {
        vast.hidden = !isVast;
        if (isVast) {
          q('[data-scan-vast-tekst]').textContent = s.wacht.tekst;
          var hulp = q('[data-scan-hulp]');
          if (hulp) { hulp.textContent = s.wacht.hulp || ''; hulp.hidden = !s.wacht.hulp; }
        }
      }
      tekst.hidden = Boolean(isVast);
      if (s.status === 'wachtrij') {
        tekst.textContent = (s.wacht && s.wacht.tekst) || 'De scan begint over een paar seconden.';
      } else if (s.status === 'bezig' || s.status === 'klaar') {
        tekst.textContent = 'We kijken van buitenaf naar je domein, mail en website. Je kunt deze pagina open laten staan.';
        if (titel && !klaarGetoond) titel.textContent = 'Qbicle scant ' + s.domain;
        if (nu && !revealing && shown >= (s.controles || []).length && s.status === 'bezig') {
          var actief = (s.steps || []).filter(function (st) { return st.status === 'bezig'; })[0];
          nu.hidden = false;
          nu.textContent = (actief ? actief.bezig : 'We controleren je domein') + '…';
        }
      }
      if (s.status === 'mislukt') {
        // Wat al gecontroleerd is direct tonen; geen kunstmatige vertraging bij een fout.
        (s.controles || []).forEach(function (c) { if (!gezien[sleutel(c)]) { gezien[sleutel(c)] = true; toon(c, true); } });
        shown = (s.controles || []).length;
        if (nu) nu.hidden = true;
        badge(q('[data-scan-badge]'), BADGE.mislukt);
        if (titel) titel.textContent = 'Scan van ' + s.domain + ' is niet gelukt';
        tekst.textContent = s.error || 'De scan is niet gelukt.';
        var opnieuw = q('[data-scan-opnieuw]');
        if (opnieuw && s.retryable) opnieuw.hidden = false;
        scanBox.querySelectorAll('a[hidden]').forEach(function (el) { if (!el.hasAttribute('data-scan-naar')) el.hidden = false; });
        return;
      }
      render();
      if (!revealing) volgende();
      if (s.status === 'klaar') return; // volgende() rondt af zodra alles in beeld is
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  }
})();
