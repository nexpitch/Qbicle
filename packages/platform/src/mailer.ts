/**
 * Uitgaande e-mail achter één interface: BrevoMailer (productie, zie brevo.ts),
 * ConsoleMailer (lokaal, zonder sleutel) en MemoryMailer (tests).
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  last(to?: string): Mail | undefined {
    const list = to ? this.sent.filter((m) => m.to.toLowerCase() === to.toLowerCase()) : this.sent;
    return list[list.length - 1];
  }
}

export class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n--- e-mail aan ${mail.to}: ${mail.subject}\n${mail.text}\n---\n`);
  }
}

/** Haalt een token uit een mailtekst (alleen voor tests en lokaal gebruik). */
export function extractToken(text: string, prefix: string): string | undefined {
  const m = text.match(new RegExp(`${prefix}[A-Za-z0-9_-]{43}`));
  return m?.[0];
}
