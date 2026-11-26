import { describe, expect, it } from 'vitest';
import { dkimCheck } from '../src/checks/dkim.ts';
import { dmarcCheck, parseDmarc } from '../src/checks/dmarc.ts';
import { parseSpf, spfCheck } from '../src/checks/spf.ts';
import { fakeNet, healthyConfig } from './fake-net.ts';
import { ctxFor, keysOf } from './helpers.ts';

const D = 'voorbeeld.nl';

function withTxt(extra: Record<string, string[] | Error>) {
  const cfg = healthyConfig(D);
  cfg.txt = { ...cfg.txt, ...extra };
  return fakeNet(cfg);
}

describe('SPF', () => {
  it('in orde bij -all met geldige include', async () => {
    const r = await keysOf(spfCheck, ctxFor(withTxt({})));
    expect(r).toMatchObject({ outcome: 'ok', keys: [] });
    expect(r.out.evidence?.lookups).toBe(1);
  });

  it('ontbreekt', async () => {
    expect((await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['google-site-verification=abc'] })))).keys).toEqual(['spf.missing']);
  });

  it('+all en "all" zonder qualifier zijn allebei te ruim', async () => {
    expect((await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 +all'] })))).keys).toEqual(['spf.plus_all']);
    expect((await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 mx all'] })))).keys).toEqual(['spf.plus_all']);
  });

  it('?all is neutraal, ~all is acceptabel', async () => {
    expect((await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 mx ?all'] })))).keys).toEqual(['spf.neutral_all']);
    expect((await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 mx ~all'] })))).outcome).toBe('ok');
  });

  it('meerdere SPF-records', async () => {
    const r = await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 mx -all', 'v=spf1 a -all'] })));
    expect(r.keys).toEqual(['spf.multiple']);
  });

  it('syntaxfout en ontbrekende afsluiting', async () => {
    const r = await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 mx ipv4:1.2.3.4'] })));
    expect(r.keys).toEqual(['spf.no_all', 'spf.syntax']);
  });

  it('redirect= telt als afsluiting', async () => {
    const r = await keysOf(
      spfCheck,
      ctxFor(withTxt({ [D]: ['v=spf1 redirect=_spf.voorbeeld.nl'], '_spf.voorbeeld.nl': ['v=spf1 mx -all'] })),
    );
    expect(r.outcome).toBe('ok');
    expect(r.out.evidence?.lookups).toBe(2);
  });

  it('meer dan 10 DNS-opvragingen', async () => {
    const includes = Array.from({ length: 6 }, (_, i) => `include:s${i}.voorbeeld.nl`).join(' ');
    const extra: Record<string, string[]> = { [D]: [`v=spf1 ${includes} -all`] };
    for (let i = 0; i < 6; i++) extra[`s${i}.voorbeeld.nl`] = ['v=spf1 a mx -all'];
    const r = await keysOf(spfCheck, ctxFor(withTxt(extra)));
    expect(r.keys).toEqual(['spf.too_many_lookups']);
  });

  it('include naar iets zonder SPF', async () => {
    const r = await keysOf(spfCheck, ctxFor(withTxt({ [D]: ['v=spf1 include:weg.example.com -all'] })));
    expect(r.keys).toEqual(['spf.include_broken']);
  });

  it('includelus loopt niet vast', async () => {
    const r = await keysOf(
      spfCheck,
      ctxFor(withTxt({ [D]: ['v=spf1 include:a.voorbeeld.nl -all'], 'a.voorbeeld.nl': [`v=spf1 include:${D} -all`] })),
    );
    expect(['ok', 'finding']).toContain(r.outcome);
  });

  it('DNS-storing wordt een fout, geen "in orde"', async () => {
    await expect(spfCheck.run(ctxFor(withTxt({ [D]: new Error('ETIMEOUT') })))).rejects.toThrow();
  });

  it('parseSpf negeert onbekende modifiers', () => {
    expect(parseSpf('v=spf1 mx foo=bar -all').syntaxErrors).toEqual([]);
  });
});

describe('DMARC', () => {
  const dm = `_dmarc.${D}`;
  it('reject met rapportage is in orde', async () => {
    expect((await keysOf(dmarcCheck, ctxFor(withTxt({})))).outcome).toBe('ok');
  });
  it.each([
    [[], ['dmarc.missing']],
    [['v=DMARC1; p=none; rua=mailto:x@voorbeeld.nl'], ['dmarc.p_none']],
    [['v=DMARC1; p=none'], ['dmarc.no_rua', 'dmarc.p_none']],
    [['v=DMARC1; p=quarantine; pct=25; rua=mailto:x@voorbeeld.nl'], ['dmarc.partial']],
    [['v=DMARC1; p=reject; sp=none; rua=mailto:x@voorbeeld.nl'], ['dmarc.sp_none']],
    [['v=DMARC1; rua=mailto:x@voorbeeld.nl'], ['dmarc.syntax']],
    [['v=DMARC1; p=reject', 'v=DMARC1; p=none'], ['dmarc.multiple']],
  ])('%j → %j', async (records, keys) => {
    expect((await keysOf(dmarcCheck, ctxFor(withTxt({ [dm]: records })))).keys).toEqual(keys);
  });
  it('parseDmarc', () => {
    expect(parseDmarc('v=DMARC1;p=reject; rua=mailto:a@b.nl ;')).toEqual({ v: 'DMARC1', p: 'reject', rua: 'mailto:a@b.nl' });
  });
});

describe('DKIM', () => {
  it('gevonden bij Microsoft-selector', async () => {
    expect((await keysOf(dkimCheck, ctxFor(withTxt({})))).outcome).toBe('ok');
  });
  it('niet gevonden is Onbekend, nooit een bevinding', async () => {
    const r = await keysOf(dkimCheck, ctxFor(withTxt({ [`selector1._domainkey.${D}`]: [] })));
    expect(r).toMatchObject({ outcome: 'unknown', keys: [] });
  });
  it('ingetrokken sleutel (lege p=) telt niet', async () => {
    const r = await keysOf(dkimCheck, ctxFor(withTxt({ [`selector1._domainkey.${D}`]: ['v=DKIM1; p='] })));
    expect(r.outcome).toBe('unknown');
  });
});
