const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const PATTERN = /^(\d+)\s*(s|m|h|d|w)$/i;

export class InvalidDurationError extends Error {
  constructor(input: string) {
    super(
      `'${input}' is not a valid duration. Use a number followed by s, m, h, d or w — ` +
        'for example 30m, 12h or 7d.',
    );
    this.name = 'InvalidDurationError';
  }
}

/**
 * Parse a human duration into milliseconds.
 *
 * Shared by config validation and slash-command options so `"7d"` means the
 * same thing in the dashboard and in `/timeout` — two parsers would eventually
 * disagree, and the disagreement would only show up as a mis-timed unban.
 */
export function parseDuration(input: string): number {
  const match = PATTERN.exec(input.trim());
  if (!match) throw new InvalidDurationError(input);

  const amount = Number(match[1]);
  const unit = UNITS[(match[2] ?? '').toLowerCase()];

  if (!Number.isFinite(amount) || unit === undefined) throw new InvalidDurationError(input);
  return amount * unit;
}

export function tryParseDuration(input: string): number | null {
  try {
    return parseDuration(input);
  } catch {
    return null;
  }
}

/** Render milliseconds back to the shortest exact form, for display. */
export function formatDuration(ms: number): string {
  for (const [suffix, size] of [
    ['w', UNITS.w],
    ['d', UNITS.d],
    ['h', UNITS.h],
    ['m', UNITS.m],
    ['s', UNITS.s],
  ] as const) {
    if (size && ms % size === 0 && ms >= size) return `${ms / size}${suffix}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
