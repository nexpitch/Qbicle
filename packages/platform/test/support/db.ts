import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEFAULT_CONFIG, loadCatalog, MemoryMailer, NepBetaalprovider, TestVies, type Platform, type TxtResolver } from '../../src/index.ts';

/**
 * Databasetests draaien tegen een echte PostgreSQL (zoals in CI). Elk testbestand
 * krijgt een eigen, verse database, gekopieerd van een sjabloon waarop alle
 * migraties uit db/migrations zijn toegepast.
 *
 * Zonder DATABASE_URL worden deze tests overgeslagen, tenzij QBICLE_REQUIRE_DB=1
 * (CI): dan falen ze, zodat ze nooit stilletjes wegvallen.
 */
export const DATABASE_URL = process.env.DATABASE_URL;
export const hasDb = Boolean(DATABASE_URL);
if (!hasDb && process.env.QBICLE_REQUIRE_DB === '1') {
  throw new Error('QBICLE_REQUIRE_DB=1 maar DATABASE_URL ontbreekt');
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
const TEMPLATE = 'qbicle_test_sjabloon';

function urlFor(db: string): string {
  const u = new URL(DATABASE_URL!);
  u.pathname = '/' + db;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Bouwt het sjabloon (eenmalig per testrun, aangeroepen vanuit globalSetup). */
export async function buildTemplate(): Promise<void> {
  if (!hasDb) return;
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE}`);
  });
  const t = new pg.Client({ connectionString: urlFor(TEMPLATE) });
  await t.connect();
  try {
    await t.query('SET client_min_messages = warning');
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await t.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  } finally {
    await t.end();
  }
}

export class FakeDns implements TxtResolver {
  records = new Map<string, string[]>();
  fail = new Set<string>();
  set(name: string, values: string[]): void {
    this.records.set(name, values);
  }
  async resolveTxt(name: string): Promise<string[]> {
    if (this.fail.has(name)) throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    return this.records.get(name) ?? [];
  }
}

export interface TestPlatform extends Platform {
  mailer: MemoryMailer;
  payments: NepBetaalprovider;
  dns: FakeDns;
  vies: TestVies;
  close(): Promise<void>;
}

export async function createTestPlatform(): Promise<TestPlatform> {
  const name = `qbicle_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 5 });
  // Bij het opruimen (DROP ... WITH (FORCE)) kan een verbinding die net sluit nog een
  // foutmelding krijgen; die hoort bij het opruimen, niet bij de test.
  pool.on('error', () => {});
  return {
    pool,
    mailer: new MemoryMailer(),
    dns: new FakeDns(),
    config: { ...DEFAULT_CONFIG, appOrigin: 'https://app.qbicle.test' },
    catalog: loadCatalog(),
    payments: new NepBetaalprovider('https://app.qbicle.test', pool),
    vies: new TestVies(),
    async close() {
      await pool.end();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
