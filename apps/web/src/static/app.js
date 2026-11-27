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
  // Hercontrole van één bevinding: elke 2 seconden de stand ophalen, bij klaar de pagina verversen.
  document.querySelectorAll('[data-hercontrole]').forEach(function (box) {
    var tekst = box.querySelector('[data-hercontrole-tekst]');
    var start = Date.now();
    var poll = async function () {
      var r;
      try { r = await send(box.dataset.hercontrole, 'GET'); } catch (e) { r = null; }
      if (r && r.status === 401) { location.href = '/inloggen'; return; }
      if (r && r.ok && (r.json.status === 'klaar' || r.json.status === 'mislukt')) { location.reload(); return; }
      if (r && r.ok && tekst && r.json.tekst) tekst.textContent = r.json.tekst;
      if (Date.now() - start > 120000) {
        if (tekst) tekst.textContent = 'Dit duurt langer dan normaal. Ververs de pagina over een minuut.';
        return;
      }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1500);
  });

  // Live voortgang van een scan: elke 2 seconden de stand ophalen en de stappen bijwerken.
  // Na afloop door naar het overzicht met de resultaten.
  var scanBox = document.querySelector('[data-scan]');
  if (scanBox && /^(wachtrij|bezig)$/.test(scanBox.dataset.scanStatus || '')) {
    var LABEL = { wachten: ['Wacht', 'unk'], bezig: ['Bezig', 'warn'], klaar: ['Klaar', 'ok'] };
    var BADGE = { wachtrij: ['In de wachtrij', 'unk'], bezig: ['Bezig', 'warn'], klaar: ['Klaar', 'ok'], mislukt: ['Niet gelukt', 'crit'] };
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
    var q = function (sel) { return scanBox.querySelector(sel); };
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
      badge(q('[data-scan-badge]'), BADGE[s.status] || BADGE.wachtrij);
      var balk = q('[data-scan-balk]');
      if (balk) { balk.value = s.pct; balk.parentNode.setAttribute('aria-valuenow', String(s.pct)); }
      (s.steps || []).forEach(function (st) {
        var li = scanBox.querySelector('[data-stap="' + st.key + '"]');
        if (!li || li.dataset.stapStatus === st.status) return;
        li.dataset.stapStatus = st.status;
        badge(li.querySelector('[data-stap-badge]'), LABEL[st.status]);
      });
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
      } else if (s.status === 'bezig') {
        tekst.textContent = 'Dit duurt meestal minder dan een minuut. Je kunt deze pagina open laten staan.';
        if (titel) titel.textContent = 'Qbicle scant ' + s.domain;
      }
      if (s.status === 'klaar') {
        if (titel) titel.textContent = 'Scan van ' + s.domain + ' is klaar';
        tekst.textContent = 'Klaar. Je resultaten staan in het overzicht.';
        var res = q('[data-scan-resultaat]');
        if (res && s.result) {
          res.textContent = 'Urgentie ' + s.result.urgency + ', ' + (s.result.openFindings === 1 ? 'één punt' : s.result.openFindings + ' punten') +
            ' om naar te kijken. We sturen je zo door naar het overzicht.';
          res.hidden = false;
        }
        scanBox.querySelectorAll('[hidden]').forEach(function (el) { if (el.matches('a')) el.hidden = false; });
        setTimeout(function () { location.href = scanBox.dataset.scanKlaar; }, 4000);
        return;
      }
      if (s.status === 'mislukt') {
        if (titel) titel.textContent = 'Scan van ' + s.domain + ' is niet gelukt';
        tekst.textContent = s.error || 'De scan is niet gelukt.';
        var opnieuw = q('[data-scan-opnieuw]');
        if (opnieuw && s.retryable) opnieuw.hidden = false;
        scanBox.querySelectorAll('a[hidden]').forEach(function (el) { if (!el.hasAttribute('data-scan-naar')) el.hidden = false; });
        return;
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  }
})();
