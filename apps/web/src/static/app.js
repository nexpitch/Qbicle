// Qbicle web-app: kleine hulp voor formulieren. De pagina's werken als gewone
// HTML; dit script stuurt formulieren als JSON naar de API (/api/v1), toont
// foutmeldingen in gewone taal en gaat daarna naar de volgende pagina.
(function () {
  'use strict';

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
    new FormData(form).forEach(function (value, key) {
      var el = form.querySelector('[name="' + key + '"]');
      if (el && el.hasAttribute('data-lijst')) {
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
      if (form.dataset.nextVeld) { location.href = pick(r.json, form.dataset.nextVeld); return; }
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
        if (!r.ok) { status.textContent = r.json.bericht || 'Deze link werkt niet meer. Vraag een nieuwe aan.'; return; }
        var reg = r.json.registratie;
        if (reg && reg.organizationId) {
          location.href = '/o/' + reg.organizationId + (reg.product === 'audit' ? '/audit/bestellen' : '/welkom');
        } else {
          location.href = tokenBox.dataset.next || '/overzicht';
        }
      }, function () {
        status.textContent = 'Geen verbinding met Qbicle. Probeer het opnieuw.';
      });
    }
  }
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
      if (s.status === 'wachtrij') {
        tekst.textContent = s.workerActief ? 'De scan begint over een paar seconden.' : 'De scanner draait op dit moment niet. De scan begint zodra hij weer draait.';
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
        scanBox.querySelectorAll('a[hidden]').forEach(function (el) { if (!el.hasAttribute('data-scan-naar')) el.hidden = false; });
        return;
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  }
})();
