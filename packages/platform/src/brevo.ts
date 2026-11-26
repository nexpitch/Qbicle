import { ConsoleMailer, type Mail, type Mailer } from './mailer.ts';

/**
 * Verzenden via Brevo (EU), Transactional Email API v3:
 *   POST https://api.brevo.com/v3/smtp/email   header: api-key
 *
 * De API-sleutel komt alleen uit de omgeving (BREVO_API_KEY). Hij staat nooit in
 * code of repository en komt nooit in logs of foutmeldingen.
 */
export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export interface BrevoOptions {
  apiKey: string;
  from: { email: string; name: string };
  replyTo?: string;
  /** Brevo verwerkt de mail maar bezorgt hem niet (header X-Sib-Sandbox: drop). Voor testen. */
  sandbox?: boolean;
  timeoutMs?: number;
  /** Aantal extra pogingen bij 429 of 5xx. */
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class MailError extends Error {}

export class BrevoMailer implements Mailer {
  readonly #apiKey: string;
  readonly #opts: Required<Omit<BrevoOptions, 'apiKey' | 'replyTo'>> & { replyTo?: string };

  constructor(opts: BrevoOptions) {
    if (!opts.apiKey?.trim()) throw new MailError('BREVO_API_KEY ontbreekt.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.from.email)) {
      throw new MailError('Zet QBICLE_MAIL_FROM op een geldig afzenderadres (geverifieerd in Brevo).');
    }
    this.#apiKey = opts.apiKey.trim();
    this.#opts = {
      from: opts.from,
      sandbox: opts.sandbox ?? false,
      timeoutMs: opts.timeoutMs ?? 10_000,
      retries: opts.retries ?? 2,
      fetch: opts.fetch ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    };
  }

  /** Nooit de sleutel tonen, ook niet bij console.log(mailer). */
  toJSON(): Record<string, unknown> {
    return { soort: 'brevo', afzender: this.#opts.from.email, sandbox: this.#opts.sandbox };
  }

  async send(mail: Mail): Promise<void> {
    const headers: Record<string, string> = {
      'api-key': this.#apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.#opts.sandbox) headers['X-Sib-Sandbox'] = 'drop';
    const body = JSON.stringify({
      sender: this.#opts.from,
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
      ...(this.#opts.replyTo ? { replyTo: { email: this.#opts.replyTo } } : {}),
      tags: ['qbicle-transactioneel'],
    });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#opts.fetch(BREVO_ENDPOINT, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.#opts.retries) {
          await this.#opts.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new MailError(`Brevo niet bereikbaar: ${(err as Error).name}`);
      }
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.#opts.retries) {
        await this.#opts.sleep(500 * 2 ** attempt);
        continue;
      }
      // Alleen status en Brevo-foutcode; geen headers of verzoek (daar zit de sleutel in).
      let code = '';
      try {
        const j = (await res.json()) as { code?: unknown };
        if (typeof j.code === 'string') code = ` (${j.code.slice(0, 60)})`;
      } catch {
        /* geen JSON */
      }
      throw new MailError(`Brevo weigerde de mail: HTTP ${res.status}${code}`);
    }
  }
}

/**
 * Kiest de mailer op basis van de omgeving:
 * - BREVO_API_KEY gezet: verzenden via Brevo (QBICLE_MAIL_FROM verplicht).
 * - Geen sleutel: mail naar de console, maar alleen buiten productie. In
 *   productie zou de console inloglinks in de logs zetten, dus dan weigeren we te starten.
 */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer {
  const apiKey = env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    if (env.NODE_ENV === 'production') {
      throw new MailError('BREVO_API_KEY ontbreekt; in productie gaat mail nooit naar de console.');
    }
    return new ConsoleMailer();
  }
  const opts: BrevoOptions = {
    apiKey,
    from: { email: env.QBICLE_MAIL_FROM?.trim() ?? '', name: env.QBICLE_MAIL_FROM_NAME?.trim() || 'Qbicle' },
    sandbox: env.QBICLE_MAIL_SANDBOX === 'aan',
  };
  const replyTo = env.QBICLE_MAIL_REPLY_TO?.trim();
  if (replyTo) opts.replyTo = replyTo;
  return new BrevoMailer(opts);
}
