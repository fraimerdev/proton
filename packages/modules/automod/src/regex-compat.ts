export type RegexVerdict = { native: true } | { native: false; reason: string };

// Discord runs `regex_patterns` through Rust's regex crate, which guarantees linear time by
// refusing every construct that needs backtracking. A pattern using one is not "invalid" — it is
// ours to run instead, which is why this classifies rather than rejects.
const UNSUPPORTED: Array<{ test: RegExp; reason: string }> = [
  { test: /\(\?=/, reason: 'lookahead (?=…)' },
  { test: /\(\?!/, reason: 'negative lookahead (?!…)' },
  { test: /\(\?<=/, reason: 'lookbehind (?<=…)' },
  { test: /\(\?<!/, reason: 'negative lookbehind (?<!…)' },
  { test: /\\[1-9]/, reason: 'a backreference (\\1)' },
  { test: /\\k</, reason: 'a named backreference (\\k<…>)' },
  { test: /\(\?</, reason: 'a named group ((?<name>…))' },
  { test: /\\c[A-Za-z]/, reason: 'a control escape (\\cA)' },
  { test: /\(\?>/, reason: 'an atomic group ((?>…))' },
  { test: /[*+?}]\+/, reason: 'a possessive quantifier (a++)' },
];

export const NATIVE_REGEX_MAX_LENGTH = 260;

export function classifyRegex(pattern: string): RegexVerdict {
  if (pattern.length > NATIVE_REGEX_MAX_LENGTH) {
    return {
      native: false,
      reason: `it is ${pattern.length} characters and Discord accepts at most ${NATIVE_REGEX_MAX_LENGTH}`,
    };
  }

  for (const { test, reason } of UNSUPPORTED) {
    if (test.test(pattern)) {
      return {
        native: false,
        reason: `it uses ${reason}, which Discord's engine has no support for`,
      };
    }
  }

  return { native: true };
}

export interface SplitPatterns {
  native: string[];
  inHouse: Array<{ pattern: string; reason: string }>;
}

export function splitPatterns(patterns: readonly string[], limit: number): SplitPatterns {
  const split: SplitPatterns = { native: [], inHouse: [] };

  for (const pattern of patterns) {
    const verdict = classifyRegex(pattern);

    if (!verdict.native) {
      split.inHouse.push({ pattern, reason: verdict.reason });
      continue;
    }

    if (split.native.length >= limit) {
      split.inHouse.push({
        pattern,
        reason: `Discord accepts only ${limit} patterns per rule and earlier ones filled them`,
      });
      continue;
    }

    split.native.push(pattern);
  }

  return split;
}
