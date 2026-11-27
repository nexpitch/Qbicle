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
})();
