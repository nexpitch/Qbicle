import { randomBytes } from 'node:crypto';

/**
 * Betaalprovider-laag. De rest van Qbicle praat alleen met deze interface, zodat
 * de testbetaling (NepBetaalprovider) later één-op-één door Mollie vervangen kan
 * worden zodra de BV er is. De provider is nooit de bron van waarheid over wat er
 * gekocht is; dat staat in onze eigen tabel `payment`. De provider zegt alleen of
 * er betaald is.
 */

export type ProviderStatus = 'open' | 'betaald' | 'mislukt' | 'verlopen' | 'geannuleerd';

export interface CreatePaymentInput {
  /** Onze eigen betaling-id (komt terug in metadata en in de redirect). */
  paymentId: string;
  amountInclCents: number;
  description: string;
  /** Waar de klant na het betalen naartoe gaat. */
  redirectUrl: string;
  /** Waar de provider statuswijzigingen meldt (Mollie). */
  webhookUrl: string;
}

export interface PaymentProvider {
  readonly name: 'nep' | 'mollie';
  createPayment(input: CreatePaymentInput): Promise<{ providerPaymentId: string; checkoutUrl: string }>;
  /** Vraagt de actuele status op bij de provider. Wij vertrouwen nooit op wat de browser zegt. */
  getStatus(providerPaymentId: string): Promise<ProviderStatus>;
  /**
   * Het incassomandaat dat bij een geslaagde (eerste) betaling is ontstaan, als de
   * provider dat ondersteunt. Bij Mollie: de mandate van de customer.
   */
  mandateFor?(providerPaymentId: string): Promise<ProviderMandate | null>;
}

export interface ProviderMandate {
  providerMandateId: string;
  method: 'sepa' | 'creditcard';
  accountHolder: string | null;
  /** Laatste vier tekens van het rekeningnummer. */
  accountLast4: string | null;
}

/**
 * Testbetaling: er gaat geen geld over. De "betaalpagina" is een pagina in onze
 * eigen web-app (/betalen/test/<id>) met de knoppen Betaald en Mislukt.
 * Staat in productie uit, tenzij QBICLE_NEPBETALING=aan (voor de gesloten bèta).
 */
export class NepBetaalprovider implements PaymentProvider {
  readonly name = 'nep' as const;
  private readonly status = new Map<string, ProviderStatus>();

  constructor(private readonly appOrigin: string) {}

  async createPayment(input: CreatePaymentInput): Promise<{ providerPaymentId: string; checkoutUrl: string }> {
    const providerPaymentId = 'nep_' + randomBytes(12).toString('base64url');
    this.status.set(providerPaymentId, 'open');
    return { providerPaymentId, checkoutUrl: `${this.appOrigin}/betalen/test/${input.paymentId}` };
  }

  async getStatus(providerPaymentId: string): Promise<ProviderStatus> {
    return this.status.get(providerPaymentId) ?? 'verlopen';
  }

  async mandateFor(providerPaymentId: string): Promise<ProviderMandate | null> {
    if (this.status.get(providerPaymentId) !== 'betaald') return null;
    return { providerMandateId: 'nep_mdt_' + providerPaymentId.slice(4, 16), method: 'sepa', accountHolder: 'Testrekening', accountLast4: '0000' };
  }

  /** Alleen voor de testbetaalpagina en tests: zet de uitkomst. */
  settle(providerPaymentId: string, outcome: 'betaald' | 'mislukt' | 'geannuleerd'): void {
    if (this.status.get(providerPaymentId) !== 'open') return;
    this.status.set(providerPaymentId, outcome);
  }
}

export function isNepProvider(p: PaymentProvider): p is NepBetaalprovider {
  return p instanceof NepBetaalprovider;
}

/** Kiest de provider uit de omgeving. Mollie volgt zodra er een BV en API-sleutel is. */
export function paymentProviderFromEnv(appOrigin: string, env = process.env): PaymentProvider {
  const choice = env.QBICLE_BETAALPROVIDER ?? 'nep';
  if (choice === 'mollie') {
    throw new Error('Mollie is nog niet gekoppeld (wacht op de BV). Gebruik QBICLE_BETAALPROVIDER=nep.');
  }
  if (choice !== 'nep') throw new Error(`Onbekende betaalprovider "${choice}"`);
  if (env.NODE_ENV === 'production' && env.QBICLE_NEPBETALING !== 'aan') {
    throw new Error('Testbetalingen staan in productie uit. Zet QBICLE_NEPBETALING=aan alleen voor de gesloten bèta.');
  }
  return new NepBetaalprovider(appOrigin);
}
