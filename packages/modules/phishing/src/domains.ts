/**
 * Domain extraction and matching.
 *
 * Pure, synchronous and free of Redis, config and Discord — everything here is
 * decidable from a string, which is what makes the false-positive rules below
 * testable exhaustively rather than by whichever example someone remembered.
 *
 * The whole module lives or dies on one decision: a blocklist entry matches a
 * host **only on label boundaries**. `content.includes('bad.com')` is the
 * obvious implementation and it is wrong in both directions at once — it flags
 * `notbad.com`, `bad.computer` and `mybad.com.au`, none of which the feed listed,
 * while a matcher naive in the other direction (`endsWith`) also flags
 * `evil.net/redirect?to=bad.com`. Labels are the only boundary a domain actually
 * has, so labels are the only boundary used.
 */

/**
 * The longest a domain name can be, per RFC 1035. Used to reject feed junk
 * rather than to bound anything at match time.
 */
export const DOMAIN_MAX_LENGTH = 253;

/**
 * A hostname with at least two labels and an alphabetic TLD.
 *
 * ASCII only, deliberately. Internationalised domains reach the wire as punycode
 * (`xn--…`), which is ASCII and matches here; a raw-unicode domain typed into a
 * message does not, and that is a known gap rather than a hidden one — see
 * `extractHosts`.
 */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Hostnames as they appear inside prose, with or without a scheme.
 *
 * Bare domains are matched too because that is how a phishing link is usually
 * pasted — a scheme-only scanner misses `steamcommunity.co/gift` entirely. The
 * cost is that ordinary prose produces candidate "hosts" (`node.js`, `etc.al`),
 * which is harmless: a candidate only matters if a blocklist actually contains
 * it, and no feed contains `node.js`.
 */
const HOST_IN_TEXT = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;

/**
 * How many hosts one message may contribute.
 *
 * A message is 2000 characters of attacker-controlled text and every host costs
 * a Redis set membership. The cap bounds that; a message carrying more than 24
 * distinct domains has already told us what it is.
 */
export const MAX_HOSTS_PER_MESSAGE = 24;

/**
 * How many suffixes one host contributes.
 *
 * Blocklist entries are registrable domains — two or three labels — so the
 * useful suffixes are the rightmost ones. The cap stops
 * `a.b.c.…(100 labels).evil.com` from turning one message into a hundred
 * membership tests.
 */
export const MAX_SUFFIXES_PER_HOST = 8;

/**
 * Reduce a feed entry or a raw host to a bare, comparable domain.
 *
 * Feeds are inconsistent about this: the same list may carry `evil.com`,
 * `http://evil.com/login`, `*.evil.com` and `EVIL.COM.`. Returns null for
 * anything that is not a domain after that, which is how a blank line, an IP
 * address or a stray comment gets dropped instead of being cached as a "domain"
 * that can never match.
 */
export function normaliseDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === '') return null;

  // Scheme, credentials, path, query and fragment — everything that is not the
  // host. Order matters: strip the scheme before splitting on `/`.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);
  value = value.split(/[/?#]/)[0] ?? '';

  // `[2001:db8::1]:443` and `evil.com:8080` — a port never distinguishes two
  // domains, and the bracket form is an IP, which `HOSTNAME` rejects below.
  value = value.replace(/^\[.*$/, '').split(':')[0] ?? '';

  // A wildcard entry and the domain itself are the same thing to a suffix
  // matcher, and the trailing dot of a fully-qualified name carries no meaning.
  value = value
    .replace(/^\*+\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  if (value.length === 0 || value.length > DOMAIN_MAX_LENGTH) return null;
  return HOSTNAME.test(value) ? value : null;
}

/**
 * Every host mentioned in a message.
 *
 * Deliberately *not* deobfuscating `evil[.]com` or `hxxps://`. Those forms exist
 * so a link is **not** clickable — they are how analysts quote a domain in a
 * report, including in a moderator channel discussing this very module. An
 * attacker wants the victim to click, so an attacker posts the live form.
 * Deobfuscating would trade a threat we do not face for false positives on
 * people talking about threats.
 */
export function extractHosts(content: string): string[] {
  const seen = new Set<string>();

  for (const match of content.matchAll(HOST_IN_TEXT)) {
    const host = normaliseDomain(match[0]);
    if (host !== null) seen.add(host);
    if (seen.size >= MAX_HOSTS_PER_MESSAGE) break;
  }

  return [...seen];
}

/**
 * The suffixes of `host` that a blocklist entry could legitimately be.
 *
 * `login.secure.evil.com` yields `login.secure.evil.com`, `secure.evil.com` and
 * `evil.com` — so a feed listing `evil.com` catches every subdomain an attacker
 * spins up under it, which is the point of listing a domain rather than a URL.
 *
 * The bare TLD is never a candidate. A feed that shipped a line reading `com` —
 * a truncated write, a stray header row — would otherwise match every host on
 * the internet and time out an entire server. Two labels minimum, always.
 */
export function domainCandidates(host: string, max: number = MAX_SUFFIXES_PER_HOST): string[] {
  const labels = host.split('.');
  if (labels.length < 2) return [];

  const suffixes: string[] = [];
  for (let start = 0; labels.length - start >= 2; start++) {
    suffixes.push(labels.slice(start).join('.'));
  }

  if (suffixes.length <= max) return suffixes;

  // Keep the full host (an exact listing of a deep subdomain still has to match)
  // and the rightmost suffixes, which is where every realistic entry lives.
  const head = suffixes.slice(0, 1);
  return [...head, ...suffixes.slice(suffixes.length - (max - 1))];
}

/**
 * Every candidate a message contributes, paired with the host it came from.
 *
 * The pairing survives to the alert: telling a moderator that `evil.com` is
 * blocked is less useful than telling them the message linked
 * `login.evil.com`, which is the string they will search the channel for.
 */
export interface HostCandidates {
  host: string;
  candidates: string[];
}

export function messageCandidates(content: string): HostCandidates[] {
  return extractHosts(content).map((host) => ({ host, candidates: domainCandidates(host) }));
}

/**
 * A per-guild domain list, prepared for matching.
 *
 * Built once per handled message rather than per candidate, and normalised on
 * the way in so an admin who types `HTTPS://Evil.COM/` into the dashboard gets
 * the entry they meant instead of one that silently never matches.
 */
export function toDomainSet(domains: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const domain of domains) {
    const normalised = normaliseDomain(domain);
    if (normalised !== null) set.add(normalised);
  }
  return set;
}

/** The first candidate of `host` present in `set`, or null. */
export function firstMatch(entry: HostCandidates, set: ReadonlySet<string>): string | null {
  for (const candidate of entry.candidates) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}
