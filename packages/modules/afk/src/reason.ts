import { REASON_MAX } from './config.ts';

export type ReasonResult = { ok: true; reason: string | null } | { ok: false; humanReason: string };

export const REASON_TOO_LONG = `Your AFK reason can be up to ${REASON_MAX} characters.`;

export const REASON_HAS_LINK = "AFK reasons can't contain links or invites.";

const LINK_TLDS = [
  'com',
  'org',
  'io',
  'gg',
  'ly',
  'xyz',
  'dev',
  'gift',
  'ru',
  'uk',
  'de',
  'cc',
  'su',
];

const WORD_TLDS = [
  'be',
  'me',
  'co',
  'tv',
  'info',
  'link',
  'app',
  'net',
  'store',
  'shop',
  'club',
  'site',
  'online',
  'live',
  'fun',
  'top',
  'one',
  'page',
  'zone',
  'life',
  'world',
  'today',
];

const INVISIBLE = /[​-‍⁠﻿]/g;

const LINK_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /(?:^|[^a-z0-9-])www\s*\./i,
  /(?:discord(?:app)?\s*\.\s*com\s*\/\s*invite|discord\s*\.\s*gg|dsc\s*\.\s*gg)\s*\//i,
  /\[[^\]]*\]\(\s*<?[^)\s]+>?\s*\)/,
  new RegExp(
    '(?:^|[^A-Za-z0-9-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+' +
      `(?:(?:${LINK_TLDS.join('|')})(?![A-Za-z0-9-])|(?:${WORD_TLDS.join('|')})\\/)`,
  ),
];

function asRendered(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}|\u{034F}|\u{180E}/gu, '')
    .replace(/[\u{3002}\u{FF0E}\u{FF61}]/gu, '.')
    .replace(/[\\*_~|`]/g, '');
}

export function containsLink(text: string): boolean {
  const rendered = asRendered(text);
  return LINK_PATTERNS.some((pattern) => pattern.test(rendered));
}

export function normaliseReason(raw: string | null | undefined): ReasonResult {
  const reason = (raw ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (reason.length === 0) return { ok: true, reason: null };

  if ([...reason].length > REASON_MAX) return { ok: false, humanReason: REASON_TOO_LONG };
  if (containsLink(reason)) return { ok: false, humanReason: REASON_HAS_LINK };

  return { ok: true, reason };
}
