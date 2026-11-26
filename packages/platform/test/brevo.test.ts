import { describe, expect, it } from 'vitest';
import { BREVO_ENDPOINT, BrevoMailer, ConsoleMailer, MailError, mailerFromEnv } from '../src/index.ts';

const KEY = 'nep-sleutel-alleen-voor-tests-1234567890';

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? new Response('{}', { status: 201 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const mail = { to: 'anna@bakkerij.nl', subject: 'Inloggen bij Qbicle', text: 'Klik: https://app.qbicle.nl/inloggen/bevestigen#token=qbl_x' };
const noSleep = async () => {};

describe('Brevo-mailer', () => {
  it('stuurt een transactionele mail naar de v3-API met de sleutel in de header', async () => {
    const f = fakeFetch([new Response('{"messageId":"<1@brevo>"}', { status: 201 })]);
    const m = new BrevoMailer({ apiKey: KEY, from: { email: 'noreply@qbicle.nl', name: 'Qbicle' }, fetch: f.fn });
    await m.send(mail);

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(BREVO_ENDPOINT);
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(KEY);
    expect(headers['X-Sib-Sandbox']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      sender: { email: 'noreply@qbicle.nl', name: 'Qbicle' },
      to: [{ email: 'anna@bakkerij.nl' }],
      subject: 'Inloggen bij Qbicle',
      textContent: mail.text,
    });
    // De sleutel staat nooit in de inhoud van het verzoek.
    expect(init.body as string).not.toContain(KEY);
  });

  it('sandboxmodus: Brevo verwerkt maar bezorgt niet', async () => {
    const f = fakeFetch([]);
    await new BrevoMailer({ apiKey: KEY, from: { email: 'noreply@qbicle.nl', name: 'Qbicle' }, sandbox: true, fetch: f.fn }).send(mail);
    expect((f.calls[0]!.init.headers as Record<string, string>)['X-Sib-Sandbox']).toBe('drop');
  });

  it('probeert opnieuw bij 429, 5xx en netwerkfouten', async () => {
    const f = fakeFetch([new Response('', { status: 429 }), new Error('ECONNRESET'), new Response('{}', { status: 201 })]);
    await new BrevoMailer({ apiKey: KEY, from: { email: 'a@qbicle.nl', name: 'Q' }, fetch: f.fn, sleep: noSleep }).send(mail);
    expect(f.calls).toHaveLength(3);
  });

  it('geeft op na de laatste poging, zonder de sleutel in de foutmelding', async () => {
    const f = fakeFetch([new Response('', { status: 503 }), new Response('', { status: 503 }), new Response('', { status: 503 })]);
    const m = new BrevoMailer({ apiKey: KEY, from: { email: 'a@qbicle.nl', name: 'Q' }, fetch: f.fn, sleep: noSleep });
    const err = await m.send(mail).catch((e: Error) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as Error).message).toContain('503');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('een geweigerde mail (bijv. ongeldige sleutel) wordt niet herhaald', async () => {
    const f = fakeFetch([new Response('{"code":"unauthorized","message":"Key not found"}', { status: 401 })]);
    const m = new BrevoMailer({ apiKey: KEY, from: { email: 'a@qbicle.nl', name: 'Q' }, fetch: f.fn, sleep: noSleep });
    await expect(m.send(mail)).rejects.toThrow('HTTP 401 (unauthorized)');
    expect(f.calls).toHaveLength(1);
  });

  it('lekt de sleutel niet bij loggen van het object', () => {
    const m = new BrevoMailer({ apiKey: KEY, from: { email: 'a@qbicle.nl', name: 'Q' } });
    expect(JSON.stringify(m)).not.toContain(KEY);
    expect(String(Object.values(m))).not.toContain(KEY);
  });
});

describe('mailer kiezen uit de omgeving', () => {
  it('zonder sleutel: console (lokaal)', () => {
    expect(mailerFromEnv({})).toBeInstanceOf(ConsoleMailer);
  });

  it('zonder sleutel in productie: weigert te starten', () => {
    expect(() => mailerFromEnv({ NODE_ENV: 'production' })).toThrow(MailError);
  });

  it('met sleutel: Brevo, en een afzender is verplicht', () => {
    expect(() => mailerFromEnv({ BREVO_API_KEY: KEY })).toThrow(/QBICLE_MAIL_FROM/);
    const m = mailerFromEnv({ BREVO_API_KEY: KEY, QBICLE_MAIL_FROM: 'noreply@qbicle.nl', QBICLE_MAIL_SANDBOX: 'aan' });
    expect(m).toBeInstanceOf(BrevoMailer);
    expect(JSON.parse(JSON.stringify(m))).toEqual({ soort: 'brevo', afzender: 'noreply@qbicle.nl', sandbox: true });
  });
});
