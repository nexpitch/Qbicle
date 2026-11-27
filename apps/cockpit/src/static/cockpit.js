// Qbicle Cockpit: formulieren met data-api gaan als JSON naar /api, met
// foutmeldingen in gewone taal. Geen inline scripts (strikte CSP).
(function () {
  'use strict';

  function pick(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
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

  function formToJson(form, submitter) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      var el = form.querySelector('[name="' + key + '"]');
      if (el && el.type === 'checkbox') {
        (data[key] = data[key] || []).push(value);
      } else if (el && el.hasAttribute('data-getal')) {
        data[key] = value === '' ? null : Number(value);
      } else {
        data[key] = value;
      }
    });
    if (submitter && submitter.name) data[submitter.name] = submitter.value;
    return data;
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
        if (r.status === 401 && form.dataset.api !== '/api/mfa') { location.href = '/inloggen'; return; }
        showError(form, r.json.bericht || 'Er ging iets mis. Probeer het opnieuw.');
        return;
      }
      if (form.dataset.next) {
        location.href = form.dataset.next.replace(/\{([\w.]+)\}/g, function (_, k) { return encodeURIComponent(pick(r.json, k) ?? ''); });
        return;
      }
      location.reload();
    } catch (x) {
      showError(form, 'Geen verbinding met de cockpit. Probeer het opnieuw.');
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  });

  // Inloglink: het token staat achter # en gaat met een POST naar de server.
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
        location.href = tokenBox.dataset.next || '/';
      }, function () {
        status.textContent = 'Geen verbinding met de cockpit. Probeer het opnieuw.';
      });
    }
  }
})();
