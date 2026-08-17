import { firstMatch, messageCandidates, toDomainSet } from '@proton/core';
import type { ActiveSeverity, AutomodCheck, AutomodConfig } from './config.ts';
import { severityOf } from './config.ts';
import { extensionOf, hasDoubleExtension, type MessageFacts, stripCodeBlocks } from './message.ts';

export interface AutomodHit {
  check: AutomodCheck;
  severity: ActiveSeverity;
  humanReason: string;
}

export type Checker = (facts: MessageFacts, config: AutomodConfig) => AutomodHit | null;

function hit(check: AutomodCheck, config: AutomodConfig, humanReason: string): AutomodHit | null {
  const severity = severityOf(config, check);
  if (severity === 'off') return null;
  return { check, severity, humanReason };
}

const INVITE =
  /(?:discord\.gg|discord(?:app)?\.com\/invite|discord\.me|dsc\.gg)\/([a-z0-9-]{2,32})/i;

export const checkInvites: Checker = (facts, config) => {
  const match = INVITE.exec(facts.normalised);
  if (!match) return null;
  return hit('invites', config, `it links to another server (\`${match[1]}\`)`);
};

export const checkLinks: Checker = (facts, config) => {
  if (config.linkBlockDomains.length === 0) return null;

  const allowed = toDomainSet(config.linkAllowDomains);
  const blocked = toDomainSet(config.linkBlockDomains);

  for (const entry of messageCandidates(stripCodeBlocks(facts.content))) {
    // Allowlist first, so a blocked parent domain never overrides an explicitly permitted child.
    if (firstMatch(entry, allowed)) continue;
    const domain = firstMatch(entry, blocked);
    if (domain) return hit('links', config, `it links to \`${domain}\`, which is blocked here`);
  }

  return null;
};

export const checkMentions: Checker = (facts, config) => {
  if (facts.mentionsEveryone) return hit('mentions', config, 'it tries to mention everyone');

  const unique = new Set(facts.mentionUserIds).size + facts.mentionRoleIds.length;
  if (unique < config.mentionsLimit) return null;

  return hit('mentions', config, `it mentions ${unique} people or roles at once`);
};

export const checkAttachments: Checker = (facts, config) => {
  if (facts.attachments.length === 0) return null;

  const blocked = new Set(config.attachmentExtensions.map((e) => e.toLowerCase()));

  for (const attachment of facts.attachments) {
    const extension = extensionOf(attachment.filename);
    if (extension && blocked.has(extension)) {
      return hit('attachments', config, `it attaches a \`.${extension}\` file`);
    }

    // `invoice.pdf.exe` is caught above; `invoice.exe.pdf` is caught here, because the real
    // extension is the last one and the first is there to be read by a human who trusts it.
    if (hasDoubleExtension(attachment.filename)) {
      const inner = extensionOf(attachment.filename.slice(0, attachment.filename.lastIndexOf('.')));
      if (inner && blocked.has(inner)) {
        return hit(
          'attachments',
          config,
          `it attaches \`${attachment.filename}\`, a disguised file`,
        );
      }
    }
  }

  return null;
};

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached) return cached;

  try {
    // Never the g or y flag: those carry lastIndex between calls, so a cached instance would
    // match every other message and nothing else.
    const compiled = new RegExp(pattern, 'i');
    if (cache.size >= 256) cache.clear();
    cache.set(pattern, compiled);
    return compiled;
  } catch {
    return null;
  }
}

export const checkPatterns: Checker = (facts, config) => {
  for (const pattern of config.regexPatterns) {
    const regex = compile(pattern);
    if (regex?.test(facts.normalised)) {
      return hit('patterns', config, 'it matches a pattern this server blocks');
    }
  }
  return null;
};

// Stack height, not the proportion of marks. Thai, Devanagari, Arabic and pointed Hebrew all
// carry many combining marks legitimately; none of them stack four on one base.
export function maxCombiningStack(content: string): number {
  let longest = 0;
  let run = 0;

  for (const char of content) {
    if (/\p{Mn}|\p{Me}|\p{Mc}/u.test(char)) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  return longest;
}

export const checkZalgo: Checker = (facts, config) => {
  if (maxCombiningStack(facts.content) < 4) return null;
  return hit('zalgo', config, 'it stacks combining marks to break the layout');
};

export function capsRatio(content: string): { ratio: number; cased: number } {
  const stripped = content
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<@!?&?\d+>/g, ' ');

  let cased = 0;
  let upper = 0;

  for (const char of stripped) {
    // Per character, never a whole-string toUpperCase: 'ß'.toUpperCase() is 'SS', so a
    // length-based ratio would drift on any German text.
    if (char.toUpperCase() === char.toLowerCase()) continue;
    cased += 1;
    if (char === char.toUpperCase()) upper += 1;
  }

  return { ratio: cased === 0 ? 0 : Math.round((upper / cased) * 100), cased };
}

export const checkCaps: Checker = (facts, config) => {
  const { ratio, cased } = capsRatio(facts.content);
  if (cased < 12 || ratio < config.capsRatio) return null;
  return hit('caps', config, `${ratio}% of it is capital letters`);
};

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countEmoji(content: string): number {
  const custom = content.match(/<a?:\w+:\d+>/g)?.length ?? 0;
  const withoutCustom = content.replace(/<a?:\w+:\d+>/g, '');

  let unicode = 0;
  for (const { segment } of segmenter.segment(withoutCustom)) {
    // Extended_Pictographic, not Emoji: the latter matches ASCII digits, which would make every
    // message with a number in it emoji spam.
    if (/\p{Extended_Pictographic}/u.test(segment)) unicode += 1;
  }

  return custom + unicode;
}

export const checkEmoji: Checker = (facts, config) => {
  const total = countEmoji(facts.content);
  if (total < config.emojiLimit) return null;
  return hit('emoji', config, `it carries ${total} emoji`);
};

export const checkWalls: Checker = (facts, config) => {
  const lines = facts.content.split('\n').length;
  if (lines < config.wallMaxLines) return null;
  return hit('walls', config, `it is ${lines} lines long`);
};

// Order is the tie-break when two checks report the same severity, so it runs cheapest and most
// specific first. Flood and duplicate are not here: they are stateful and run separately.
export const STATELESS_CHECKS: Checker[] = [
  checkInvites,
  checkLinks,
  checkMentions,
  checkAttachments,
  checkPatterns,
  checkZalgo,
  checkCaps,
  checkEmoji,
  checkWalls,
];
