export const DOMAIN_MAX_LENGTH = 253;

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const HOST_IN_TEXT = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;

export const MAX_HOSTS_PER_MESSAGE = 24;

export const MAX_SUFFIXES_PER_HOST = 8;

export function normaliseDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === '') return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);
  value = value.split(/[/?#]/)[0] ?? '';

  value = value.replace(/^\[.*$/, '').split(':')[0] ?? '';

  value = value
    .replace(/^\*+\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  if (value.length === 0 || value.length > DOMAIN_MAX_LENGTH) return null;
  return HOSTNAME.test(value) ? value : null;
}

export function extractHosts(content: string): string[] {
  const seen = new Set<string>();

  for (const match of content.matchAll(HOST_IN_TEXT)) {
    const host = normaliseDomain(match[0]);
    if (host !== null) seen.add(host);
    if (seen.size >= MAX_HOSTS_PER_MESSAGE) break;
  }

  return [...seen];
}

export function domainCandidates(host: string, max: number = MAX_SUFFIXES_PER_HOST): string[] {
  const labels = host.split('.');
  if (labels.length < 2) return [];

  const suffixes: string[] = [];
  for (let start = 0; labels.length - start >= 2; start++) {
    suffixes.push(labels.slice(start).join('.'));
  }

  if (suffixes.length <= max) return suffixes;

  const head = suffixes.slice(0, 1);
  return [...head, ...suffixes.slice(suffixes.length - (max - 1))];
}

export interface HostCandidates {
  host: string;
  candidates: string[];
}

export function messageCandidates(content: string): HostCandidates[] {
  return extractHosts(content).map((host) => ({ host, candidates: domainCandidates(host) }));
}

export function toDomainSet(domains: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const domain of domains) {
    const normalised = normaliseDomain(domain);
    if (normalised !== null) set.add(normalised);
  }
  return set;
}

export function firstMatch(entry: HostCandidates, set: ReadonlySet<string>): string | null {
  for (const candidate of entry.candidates) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}
