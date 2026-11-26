/**
 * Versies vergelijken zoals NVD-versiebereiken bedoeld zijn: per segment,
 * numeriek waar het kan ("7.10" > "7.9"), anders als tekst ("7.57a" > "7.57").
 */
export function compareVersions(a: string, b: string): number {
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return isZeroTail(pb.slice(i)) ? 0 : -1;
    if (y === undefined) return isZeroTail(pa.slice(i)) ? 0 : 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const c = String(x).localeCompare(String(y));
      if (c !== 0) return c < 0 ? -1 : 1;
    }
  }
  return 0;
}

function split(v: string): Array<number | string> {
  return v
    .toLowerCase()
    .replace(/^v/, '')
    .split(/[.\-_+]/)
    .flatMap((part) => part.match(/\d+|[a-z]+/g) ?? [])
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function isZeroTail(rest: Array<number | string>): boolean {
  return rest.every((p) => p === 0);
}

export interface VersionRange {
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
}

export function inRange(version: string, r: VersionRange): boolean {
  if (r.versionStartIncluding && compareVersions(version, r.versionStartIncluding) < 0) return false;
  if (r.versionStartExcluding && compareVersions(version, r.versionStartExcluding) <= 0) return false;
  if (r.versionEndIncluding && compareVersions(version, r.versionEndIncluding) > 0) return false;
  if (r.versionEndExcluding && compareVersions(version, r.versionEndExcluding) >= 0) return false;
  return true;
}

export function hasRange(r: VersionRange): boolean {
  return Boolean(r.versionStartIncluding || r.versionStartExcluding || r.versionEndIncluding || r.versionEndExcluding);
}
