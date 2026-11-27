import { describe, expect, it } from 'vitest';
import { waitInfo } from '../src/scanstatus.ts';

describe('waitInfo: wat de klant ziet zolang een scan in de wachtrij staat', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it('scanner draait en scan is net gestart: begint zo', () => {
    expect(waitInfo({ createdAt: ago(5), workerActief: true, anderBezig: false, now })).toMatchObject({ vast: false, tekst: 'De scan begint over een paar seconden.' });
  });
  it('scanner is met een ander domein bezig: geen alarm', () => {
    expect(waitInfo({ createdAt: ago(120), workerActief: true, anderBezig: true, now }).vast).toBe(false);
  });
  it('na 30 seconden zonder start: de scanner draait niet, met hulp buiten productie', () => {
    const w = waitInfo({ createdAt: ago(31), workerActief: false, anderBezig: false, now, production: false });
    expect(w.vast).toBe(true);
    expect(w.hulp).toContain('klantomgeving.sh');
  });
  it('in productie geen Docker-uitleg voor de klant', () => {
    const w = waitInfo({ createdAt: ago(60), workerActief: false, anderBezig: false, now, production: true });
    expect(w.vast).toBe(true);
    expect(w.hulp).toBeNull();
    expect(w.tekst).toContain('Je hoeft niets te doen');
  });
});
